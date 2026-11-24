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
import { HermesAdapter } from '../adapters/hermes.js';
import { createNativeAdapter, createNativeSessionId } from '../adapters/native.js';
import { matchStreamedInterim, stripTrailingText } from '../config.js';
import { verifyBearerToken } from '../policy/auth.js';
import type { AgentAdapter, AgentConfig } from '../types.js';
import { VERSION } from '../version.js';
import {
  STOP_RECOVERY_CAPABILITY,
  STOP_RECOVERY_REQUEST,
  STOP_RECOVERY_TURN_ID,
  type StopRecoveryParams,
  type StopRecoveryResponse,
} from './stop-recovery.js';

const MAX_TRACKED_SESSIONS = 500;
const MAX_RECOVERY_ID_LENGTH = 1024;
const STOP_RECOVERY_TURN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface RecoverableTurn {
  sessionId: string;
  runId?: string;
}

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
    const stopRecovery = new Map<string, RecoverableTurn>();
    const acpServer = new AcpServer({
      createAgent: () => createAcpAgent(this.config, this.factory(this.config), stopRecovery),
    });
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

export function createAcpAgent(
  config: AgentConfig,
  adapter: AgentAdapter,
  stopRecovery?: Map<string, RecoverableTurn>,
): AgentApp {
  const cancelled = new Set<string>();
  const sessionCwds = new Map<string, string>();
  const hermesPrompts = adapter.kind === 'hermes' ? new Map<string, { stopUnconfirmed: boolean }>() : undefined;
  const recoveryAdapter = stopRecovery && adapter instanceof HermesAdapter ? adapter : undefined;
  let supportsInterimRetraction = false;
  let supportsStopRecovery = false;
  const app = agent({ name: 'dsh-knot-acp-bridge' });
  app.onConnect((connection: AgentConnection) => {
    void connection.closed.then(() => adapter.close());
  });
  app.onRequest(methods.agent.initialize, async ({ params, signal }) => {
    await adapter.health(signal);
    supportsInterimRetraction = adapter.kind === 'hermes' && params._meta?.['dsh-knot/interimRetraction'] === true;
    supportsStopRecovery = recoveryAdapter !== undefined && params._meta?.[STOP_RECOVERY_CAPABILITY] === true;
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: 'dsh-knot-acp-bridge', version: VERSION },
      ...(supportsInterimRetraction || supportsStopRecovery
        ? {
            _meta: {
              ...(supportsInterimRetraction ? { 'dsh-knot/interimRetraction': true } : {}),
              ...(supportsStopRecovery ? { [STOP_RECOVERY_CAPABILITY]: true } : {}),
            },
          }
        : {}),
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        sessionCapabilities: { list: {}, resume: {} },
      },
    };
  });
  if (stopRecovery && recoveryAdapter) {
    app.onRequest<StopRecoveryParams, StopRecoveryResponse>(
      STOP_RECOVERY_REQUEST,
      parseStopRecoveryParams,
      async ({ params, signal }) => {
        if (!supportsStopRecovery) throw RequestError.methodNotFound(STOP_RECOVERY_REQUEST);
        const turn = stopRecovery.get(params.turnId);
        if (turn?.sessionId !== params.sessionId || !turn.runId) {
          throw RequestError.internalError(undefined, 'The Hermes run is unavailable for stop recovery');
        }
        await recoveryAdapter.cancelRun(turn.runId, signal);
        return { stopped: true };
      },
    );
  }
  app.onRequest(methods.agent.session.new, ({ params }) => {
    const sessionId = createNativeSessionId(config);
    sessionCwds.delete(sessionId);
    sessionCwds.set(sessionId, params.cwd);
    while (sessionCwds.size > MAX_TRACKED_SESSIONS) {
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
    while (sessionCwds.size > MAX_TRACKED_SESSIONS) {
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
    const text = params.prompt.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
    const toolIds = new Map<string, string>();
    const MAX_PENDING_TEXT_CHARS = 2_000_000;
    const deferTextUntilBoundary = adapter.kind === 'hermes' && !supportsInterimRetraction;
    let pendingText = '';
    // Tracks live-streamed deltas in the current LLM step so paired clients with interim retraction
    // can retract both full `already_streamed: true` commentary and truncated-prefix `false` resends.
    let stepStreamed = '';
    let output = '';
    let stopReason: StopReason = 'end_turn';
    const notify = async (update: SessionUpdate) => {
      await client.notify(methods.client.session.update, { sessionId, update });
    };
    const flushPendingText = async () => {
      if (!pendingText) return;
      const chunk = pendingText;
      pendingText = '';
      output += chunk;
      await notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } });
    };
    const previousPrompt = hermesPrompts?.get(sessionId);
    if (previousPrompt) {
      const detail = previousPrompt.stopUnconfirmed
        ? 'The previous Hermes run stop is unconfirmed. Retry session/cancel before sending another prompt'
        : 'Session already has an active prompt';
      throw RequestError.internalError(undefined, detail);
    }
    if (hermesPrompts && hermesPrompts.size >= MAX_TRACKED_SESSIONS) {
      throw RequestError.internalError(undefined, 'Too many Hermes sessions with active prompts or unconfirmed stops');
    }
    let recoveryTurn: RecoverableTurn | undefined;
    if (supportsStopRecovery && stopRecovery) {
      const turnId = params.prompt.find((block) => block.type === 'text')?._meta?.[STOP_RECOVERY_TURN_ID];
      if (turnId !== undefined) {
        const recoveryParams = parseStopRecoveryParams({ sessionId, turnId });
        if (stopRecovery.has(recoveryParams.turnId)) throw RequestError.invalidParams(undefined, 'Duplicate turn ID');
        recoveryTurn = { sessionId };
        stopRecovery.set(recoveryParams.turnId, recoveryTurn);
        if (stopRecovery.size > MAX_TRACKED_SESSIONS) {
          const oldest = stopRecovery.keys().next().value;
          if (oldest !== undefined) stopRecovery.delete(oldest);
        }
      }
    }
    const promptOwner = { stopUnconfirmed: false };
    let stopUnconfirmed = false;
    // Hermes cancels by session ID, so a prompt owns the session until overflow cleanup is confirmed.
    hermesPrompts?.set(sessionId, promptOwner);
    cancelled.delete(sessionId);
    try {
      const events =
        recoveryTurn && recoveryAdapter
          ? recoveryAdapter.prompt(sessionId, text, signal, undefined, (runId) => {
              if (runId.length <= MAX_RECOVERY_ID_LENGTH) recoveryTurn.runId = runId;
            })
          : adapter.prompt(sessionId, text, signal);
      for await (const event of events) {
        if (event.type === 'text' && event.text) {
          if (event.interim) {
            const buffer = deferTextUntilBoundary ? pendingText : stepStreamed;
            const retract =
              event.retractText ??
              (event.alreadyStreamed
                ? matchStreamedInterim(buffer, event.text) || event.text
                : matchStreamedInterim(buffer, event.text));
            if (deferTextUntilBoundary) {
              if (retract) pendingText = stripTrailingText(pendingText, retract);
              await flushPendingText();
            } else {
              if (retract) output = stripTrailingText(output, retract);
              stepStreamed = '';
            }
            // Carry mid-turn commentary on agent_thought_chunk with explicit _meta so generic ACP
            // readText() callers keep clean final replies while dsh-knot preserves commentary in UI.
            await notify({
              sessionUpdate: 'agent_thought_chunk',
              content: { type: 'text', text: event.text },
              _meta: {
                'dsh-knot/commentary': true,
                ...(!deferTextUntilBoundary && retract
                  ? { 'dsh-knot/alreadyStreamed': true, 'dsh-knot/retractText': retract }
                  : {}),
              },
            });
          } else if (deferTextUntilBoundary) {
            // Hold Hermes text deltas for generic ACP clients until a non-reasoning turn boundary so
            // commentary is classified before anything is emitted on the standard ACP answer channel.
            if (pendingText.length + event.text.length > MAX_PENDING_TEXT_CHARS) {
              pendingText = '';
              const detail = `Hermes unclassified text exceeded the ${MAX_PENDING_TEXT_CHARS} character buffer limit`;
              try {
                await adapter.cancel(sessionId, signal);
              } catch {
                stopUnconfirmed = true;
                throw RequestError.internalError(undefined, `${detail}. The remote stop is unconfirmed`);
              }
              throw RequestError.internalError(undefined, detail);
            }
            pendingText += event.text;
          } else {
            output += event.text;
            stepStreamed = (stepStreamed + event.text).slice(-MAX_PENDING_TEXT_CHARS);
            await notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: event.text } });
          }
        } else if (event.type === 'thought' && event.text) {
          // Hermes can emit reasoning.available between commentary deltas and message.interim;
          // keep pendingText / stepStreamed unclassified across reasoning updates.
          await notify({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: event.text } });
        } else if (event.type === 'tool') {
          await flushPendingText();
          stepStreamed = '';
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
          await flushPendingText();
          stepStreamed = '';
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
          if (event.phase === 'end' || (supportsInterimRetraction && cancelled.has(sessionId))) continue;
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
          if (supportsInterimRetraction && cancelled.has(sessionId)) continue;
          if (response.outcome.outcome !== 'selected') {
            cancelled.add(sessionId);
            await adapter.cancel(sessionId, signal);
            stopReason = 'cancelled';
            break;
          }
          await adapter.respond(sessionId, event.requestId ?? '', response.outcome.optionId, signal);
        } else if (event.type === 'error') {
          await flushPendingText();
          throw new Error(event.text ?? 'Remote agent failed');
        } else if (event.type === 'final') {
          await flushPendingText();
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
      await flushPendingText();
      return { stopReason: cancelled.has(sessionId) ? 'cancelled' : stopReason };
    } catch (error) {
      await flushPendingText().catch(() => {
        /* best-effort partial output flush before propagating the adapter error */
      });
      throw error;
    } finally {
      if (stopUnconfirmed) promptOwner.stopUnconfirmed = true;
      else hermesPrompts?.delete(sessionId);
    }
  });
  app.onNotification(methods.agent.session.cancel, async ({ params, signal }) => {
    const { sessionId } = params;
    const promptOwner = hermesPrompts?.get(sessionId);
    cancelled.add(sessionId);
    await adapter.cancel(sessionId, signal);
    if (promptOwner?.stopUnconfirmed && hermesPrompts?.get(sessionId) === promptOwner) hermesPrompts.delete(sessionId);
  });
  return app;
}

function parseStopRecoveryParams(params: unknown): StopRecoveryParams {
  if (params && typeof params === 'object' && 'sessionId' in params && 'turnId' in params) {
    const { sessionId, turnId } = params;
    if (
      typeof sessionId === 'string' &&
      sessionId.length > 0 &&
      sessionId.length <= MAX_RECOVERY_ID_LENGTH &&
      typeof turnId === 'string' &&
      STOP_RECOVERY_TURN_RE.test(turnId)
    ) {
      return { sessionId, turnId };
    }
  }
  throw RequestError.invalidParams(undefined, 'Invalid Hermes stop recovery session or turn ID');
}

function acpStopReason(reason: string | undefined): StopReason {
  const value = reason?.toLowerCase() ?? '';
  if (value.includes('cancel')) return 'cancelled';
  if (value.includes('max') && value.includes('token')) return 'max_tokens';
  if (value.includes('max') && value.includes('turn')) return 'max_turn_requests';
  if (value.includes('refusal')) return 'refusal';
  return 'end_turn';
}
