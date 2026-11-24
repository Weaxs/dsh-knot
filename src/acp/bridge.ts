import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable, Writable } from 'node:stream';
import {
  type AgentApp,
  type AgentConnection,
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type RequestPermissionResponse,
  type SessionUpdate,
  type StopReason,
} from '@agentclientprotocol/sdk';
import { createNodeWebSocketUpgradeHandler } from '@agentclientprotocol/sdk/experimental/node';
import { AcpServer } from '@agentclientprotocol/sdk/experimental/server';
import { WebSocketServer } from 'ws';
import { createNativeAdapter, createNativeSessionId } from '../adapters/native.js';
import { stripTrailingText } from '../config.js';
import { verifyBearerToken } from '../policy/auth.js';
import type { AgentAdapter, AgentConfig } from '../types.js';
import { VERSION } from '../version.js';

export type NativeAdapterFactory = (config: AgentConfig) => AgentAdapter;

export interface AcpBridgeOptions {
  host?: string;
  port?: number;
  token?: string;
}

export async function runAcpStdio(
  config: AgentConfig,
  factory: NativeAdapterFactory = createNativeAdapter,
): Promise<void> {
  const connection = createAcpAgent(config, factory(config)).connect(
    ndJsonStream(
      Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>,
      Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
    ),
  );
  await connection.closed;
}

export class AcpBridge {
  private server?: http.Server;
  private acpServer?: AcpServer;
  private webSocketServer?: WebSocketServer;

  constructor(
    private readonly config: AgentConfig,
    private readonly factory: NativeAdapterFactory = createNativeAdapter,
  ) {}

  async start(options: AcpBridgeOptions = {}): Promise<{ host: string; port: number }> {
    const host = options.host ?? '127.0.0.1';
    const token = options.token ?? process.env.DSH_KNOT_ACP_TOKEN;
    if (!['127.0.0.1', '::1', 'localhost'].includes(host) && !token) {
      throw new Error('DSH_KNOT_ACP_TOKEN is required when the ACP bridge is not loopback-only');
    }
    const acpServer = new AcpServer({ createAgent: () => createAcpAgent(this.config, this.factory(this.config)) });
    const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
    const upgrade = createNodeWebSocketUpgradeHandler(acpServer, webSocketServer);
    const server = http.createServer((request, response) => {
      if (request.url === '/health') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ ok: true, protocol: 'acp', protocolVersion: PROTOCOL_VERSION }));
        return;
      }
      response.writeHead(404).end();
    });
    server.on('upgrade', (request, socket, head) => {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (path !== '/acp') {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      if (token && !verifyBearerToken(request.headers.authorization, token)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      upgrade(request, socket, head);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? 18_792, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
    this.acpServer = acpServer;
    this.webSocketServer = webSocketServer;
    const address = server.address() as AddressInfo;
    return { host, port: address.port };
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    for (const client of this.webSocketServer?.clients ?? []) client.terminate();
    await this.acpServer?.close();
    this.acpServer = undefined;
    this.webSocketServer?.close();
    this.webSocketServer = undefined;
    if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

export function createAcpAgent(config: AgentConfig, adapter: AgentAdapter): AgentApp {
  const cancelled = new Set<string>();
  const sessionCwds = new Map<string, string>();
  const app = agent({ name: 'dsh-knot-acp-bridge' });
  app.onConnect((connection: AgentConnection) => {
    void connection.closed.then(() => adapter.close());
  });
  app.onRequest(methods.agent.initialize, async ({ signal }) => {
    await adapter.health(signal);
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: 'dsh-knot-acp-bridge', version: VERSION },
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        sessionCapabilities: { list: {}, resume: {} },
      },
    };
  });
  app.onRequest(methods.agent.session.new, ({ params }) => {
    const sessionId = createNativeSessionId(config);
    sessionCwds.delete(sessionId);
    sessionCwds.set(sessionId, params.cwd);
    while (sessionCwds.size > 500) {
      const oldest = sessionCwds.keys().next().value;
      if (oldest === undefined) break;
      sessionCwds.delete(oldest);
    }
    cancelled.delete(sessionId);
    return { sessionId };
  });
  app.onRequest(methods.agent.session.resume, async ({ params, signal }) => {
    const known =
      sessionCwds.has(params.sessionId) ||
      (await adapter.listSessions(signal)).some((session) => session.id === params.sessionId);
    if (!known) throw RequestError.resourceNotFound(params.sessionId);
    sessionCwds.delete(params.sessionId);
    sessionCwds.set(params.sessionId, params.cwd);
    while (sessionCwds.size > 500) {
      const oldest = sessionCwds.keys().next().value;
      if (oldest === undefined) break;
      sessionCwds.delete(oldest);
    }
    cancelled.delete(params.sessionId);
    return {};
  });
  app.onRequest(methods.agent.session.list, async ({ signal }) => {
    const sessions = await adapter.listSessions(signal);
    return {
      sessions: sessions.map((session) => {
        const updatedAt = new Date(session.updatedAt ?? Number.NaN);
        return {
          sessionId: session.id,
          cwd: sessionCwds.get(session.id) ?? config.dshCwd ?? '/',
          title: session.title,
          updatedAt: Number.isFinite(updatedAt.getTime()) ? updatedAt.toISOString() : undefined,
        };
      }),
    };
  });
  app.onRequest(methods.agent.session.prompt, async ({ params, client, signal }) => {
    const sessionId = params.sessionId;
    cancelled.delete(sessionId);
    const text = params.prompt.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
    const toolIds = new Map<string, string>();
    let output = '';
    let stopReason: StopReason = 'end_turn';
    const notify = async (update: SessionUpdate) => {
      await client.notify(methods.client.session.update, { sessionId, update });
    };
    for await (const event of adapter.prompt(sessionId, text, signal)) {
      if (event.type === 'text' && event.text) {
        if (event.interim) {
          if (event.alreadyStreamed) output = stripTrailingText(output, event.text);
          // Carry mid-turn commentary on agent_thought_chunk with explicit _meta so generic ACP
          // readText() callers keep clean final replies while dsh-knot preserves commentary in UI.
          await notify({
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: event.text },
            _meta: {
              'dsh-knot/commentary': true,
              ...(event.alreadyStreamed ? { 'dsh-knot/alreadyStreamed': true } : {}),
            },
          });
        } else {
          output += event.text;
          await notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: event.text } });
        }
      } else if (event.type === 'thought' && event.text) {
        await notify({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: event.text } });
      } else if (event.type === 'tool') {
        const key = event.requestId ? `id:${event.requestId}` : `name:${event.name ?? 'tool'}`;
        const knownId = toolIds.get(key);
        const toolCallId = knownId ?? event.requestId ?? randomUUID();
        if (event.phase === 'end') toolIds.delete(key);
        else if (!knownId) {
          if (toolIds.size >= 500) throw new Error('Too many concurrent tool calls');
          toolIds.set(key, toolCallId);
        }
        const status =
          event.phase === 'end'
            ? event.failed
              ? 'failed'
              : 'completed'
            : event.phase === 'start'
              ? 'in_progress'
              : event.phase;
        if (knownId) {
          await notify({
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status,
            name: event.name,
            title: event.title,
            rawInput: event.inputPreview,
          });
        } else {
          await notify({
            sessionUpdate: 'tool_call',
            toolCallId,
            title: event.title ?? event.name ?? 'Tool call',
            name: event.name,
            kind: 'other',
            status,
            rawInput: event.inputPreview,
          });
        }
      } else if (event.type === 'approval') {
        if (!adapter.respond) {
          if (!event.requestId) continue;
          await notify(
            event.phase === 'end'
              ? { sessionUpdate: 'tool_call_update', toolCallId: event.requestId, status: 'completed' }
              : {
                  sessionUpdate: 'tool_call',
                  toolCallId: event.requestId,
                  title: 'Approval required on the remote gateway',
                  status: 'pending',
                  rawInput: event.text,
                },
          );
          continue;
        }
        if (event.phase === 'end') continue;
        const choices = event.choices?.length ? event.choices : ['approve', 'reject'];
        const toolCallId = event.requestId || randomUUID();
        const response = (await client.request(
          methods.client.session.requestPermission,
          {
            sessionId,
            toolCall: {
              toolCallId,
              title: event.text ?? 'Permission requested',
              kind: 'other',
              status: 'pending',
            },
            options: choices.map((choice) => ({
              optionId: choice,
              name: choice,
              kind: /reject|deny|no/i.test(choice) ? ('reject_once' as const) : ('allow_once' as const),
            })),
          },
          { cancellationSignal: signal, stopWaitingOnCancel: true },
        )) as RequestPermissionResponse;
        if (response.outcome.outcome !== 'selected') {
          cancelled.add(sessionId);
          await adapter.cancel(sessionId, signal);
          stopReason = 'cancelled';
          break;
        }
        await adapter.respond(sessionId, event.requestId ?? '', response.outcome.optionId, signal);
      } else if (event.type === 'error') {
        throw new Error(event.text ?? 'Remote agent failed');
      } else if (event.type === 'final') {
        const finalText = event.text ?? '';
        const remaining = finalText.startsWith(output)
          ? finalText.slice(output.length)
          : output.endsWith(finalText)
            ? ''
            : finalText;
        if (remaining) {
          output += remaining;
          await notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: remaining } });
        }
        stopReason = acpStopReason(event.stopReason);
        break;
      }
    }
    return { stopReason: cancelled.has(sessionId) ? 'cancelled' : stopReason };
  });
  app.onNotification(methods.agent.session.cancel, async ({ params, signal }) => {
    cancelled.add(params.sessionId);
    await adapter.cancel(params.sessionId, signal);
  });
  return app;
}

function acpStopReason(reason: string | undefined): StopReason {
  const value = reason?.toLowerCase() ?? '';
  if (value.includes('cancel')) return 'cancelled';
  if (value.includes('max') && value.includes('token')) return 'max_tokens';
  if (value.includes('max') && value.includes('turn')) return 'max_turn_requests';
  if (value.includes('refusal')) return 'refusal';
  return 'end_turn';
}
