import { type ChildProcess, spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import {
  type ActiveSession,
  type ActiveSessionMessage,
  type AgentCapabilities,
  type ClientConnection,
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type RequestPermissionResponse,
  type SessionUpdate,
} from '@agentclientprotocol/sdk';
import { createWebSocketStream } from '@agentclientprotocol/sdk/experimental/ws-client';
import WebSocket from 'ws';
import { AsyncQueue } from '../async-queue.js';
import { raceAbort, secret, shouldSkipRemoteCancel, stripTrailingText, urlHost } from '../config.js';
import { toolInputPreview } from '../policy/redact.js';
import { transportFor } from '../transports/http.js';
import type { AgentAdapter, AgentConfig, AgentEvent, AgentSession, Transport } from '../types.js';
import { VERSION } from '../version.js';

interface PendingPermission {
  sessionId: string;
  resolve: (response: RequestPermissionResponse) => void;
}

type PromptMessage = { kind: 'acp'; value: ActiveSessionMessage } | { kind: 'native'; value: AgentEvent };

export class AcpAdapter implements AgentAdapter {
  readonly kind = 'acp' as const;
  private readonly transport: Transport;
  private readonly queues = new Map<string, AsyncQueue<PromptMessage>>();
  private readonly inFlightPrompts = new Map<string, Promise<void>>();
  private readonly activeSessions = new Map<string, ActiveSession>();
  private readonly loadedSessions = new Set<string>();
  private readonly sessionIds = new Map<string, string>();
  private readonly sessionCwds = new Map<string, string>();
  private readonly permissions = new Map<string, PendingPermission>();
  private readonly pumping = new Set<string>();
  private connection?: ClientConnection;
  private child?: ChildProcess;
  private connecting?: Promise<void>;
  private capabilities?: AgentCapabilities;

  constructor(
    readonly id: string,
    private readonly config: AgentConfig,
    transport?: Transport,
  ) {
    this.transport = transport ?? transportFor(config);
  }

  async health(signal?: AbortSignal): Promise<Record<string, unknown>> {
    await this.connect(signal);
    return { ok: true, protocol: 'acp', protocolVersion: PROTOCOL_VERSION, capabilities: this.capabilities };
  }

  async listSessions(signal?: AbortSignal, stopWhenId?: string, maxItems = 100): Promise<AgentSession[]> {
    await this.connect(signal);
    if (!this.capabilities?.sessionCapabilities?.list) return [];
    const sessions: AgentSession[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      let result: {
        sessions: Array<{ sessionId: string; title?: string | null; cwd?: string | null; updatedAt?: string | null }>;
        nextCursor?: string | null;
      };
      try {
        result = await this.connection!.agent.request(methods.agent.session.list, cursor ? { cursor } : {}, {
          cancellationSignal: signal,
          stopWaitingOnCancel: true,
        });
      } catch (error) {
        if (page > 0 && sessions.length > 0 && !stopWhenId) break;
        throw error;
      }
      for (const session of result.sessions) {
        if (session.cwd) this.rememberSessionCwd(session.sessionId, session.cwd);
        sessions.push({
          id: session.sessionId,
          title: session.title ?? undefined,
          ...(session.cwd ? { cwd: session.cwd } : {}),
          updatedAt: session.updatedAt ?? undefined,
        });
      }
      if (stopWhenId && this.sessionCwds.has(stopWhenId)) break;
      if (!stopWhenId && maxItems > 0 && sessions.length >= maxItems) break;
      const next = result.nextCursor ?? undefined;
      if (!next || seenCursors.has(next)) break;
      seenCursors.add(next);
      cursor = next;
    }
    return !stopWhenId && maxItems > 0 ? sessions.slice(0, maxItems) : sessions;
  }

  isSessionBusy(sessionId: string): boolean {
    const actualId = this.sessionIds.get(sessionId) ?? sessionId;
    return this.queues.has(actualId) || this.inFlightPrompts.has(actualId);
  }

  async *prompt(sessionId: string | undefined, text: string, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    let actualId = sessionId ?? '';
    let output = '';
    const queue = new AsyncQueue<PromptMessage>(1_024, 'error');
    try {
      await this.connect(signal);
      let active = sessionId ? this.activeSessions.get(sessionId) : undefined;
      if (!active && sessionId) {
        if (!this.loadedSessions.has(sessionId)) {
          const canResume = Boolean(this.capabilities?.sessionCapabilities?.resume);
          const canLoad = Boolean(this.capabilities?.loadSession);
          if (!canResume && !canLoad) {
            throw new Error(
              `ACP agent "${this.id}" does not support session/resume or session/load; cannot continue uncached session "${sessionId}"`,
            );
          }
          if (!this.sessionCwds.has(sessionId) && this.capabilities?.sessionCapabilities?.list) {
            await this.listSessions(signal, sessionId).catch(() => {
              /* best-effort cwd discovery before resume/load; fall back to configured dshCwd or '/' */
            });
          }
          const cwd = this.sessionCwds.get(sessionId) ?? this.config.dshCwd ?? '/';
          if (canResume) {
            await this.connection!.agent.request(
              methods.agent.session.resume,
              { sessionId, cwd },
              { cancellationSignal: signal, stopWaitingOnCancel: true },
            );
          } else {
            await this.connection!.agent.request(
              methods.agent.session.load,
              { sessionId, cwd, mcpServers: [] },
              { cancellationSignal: signal, stopWaitingOnCancel: true },
            );
          }
          this.rememberLoadedSession(sessionId);
        }
        actualId = sessionId;
        if (this.queues.has(actualId) || this.inFlightPrompts.has(actualId)) {
          throw new Error(`ACP session "${actualId}" already has an active prompt in progress`);
        }
        this.queues.set(actualId, queue);
        yield { type: 'text', text: '', sessionId: actualId };
        const remotePrompt = this.connection!.agent.request(methods.agent.session.prompt, {
          sessionId: actualId,
          prompt: [{ type: 'text', text }],
        });
        this.trackInFlight(actualId, remotePrompt);
        remotePrompt.then(
          (response) => {
            queue.push({
              kind: 'native',
              value: { type: 'final', text: output, stopReason: response.stopReason, sessionId: actualId },
            });
          },
          (error) => {
            queue.push({
              kind: 'native',
              value: { type: 'error', text: error instanceof Error ? error.message : String(error) },
            });
          },
        );
      } else {
        if (!active) {
          active = await this.connection!.agent.buildSession({ cwd: this.config.dshCwd ?? '/', mcpServers: [] }).start({
            cancellationSignal: signal,
            stopWaitingOnCancel: true,
          });
          actualId = active.sessionId;
          this.rememberSession(actualId, actualId, active);
        } else {
          actualId = active.sessionId;
        }
        if (this.queues.has(actualId) || this.inFlightPrompts.has(actualId)) {
          throw new Error(`ACP session "${actualId}" already has an active prompt in progress`);
        }
        this.queues.set(actualId, queue);
        yield { type: 'text', text: '', sessionId: actualId };
        const completion = active.prompt(text);
        this.trackInFlight(actualId, completion);
        completion.catch((error) => {
          queue.push({
            kind: 'native',
            value: { type: 'error', text: error instanceof Error ? error.message : String(error) },
          });
        });
        this.pumpUpdates(actualId, active);
      }
      while (true) {
        const next = await queue.next(signal);
        if (next.done) throw new Error('ACP event stream ended before the prompt completed');
        if (next.value.kind === 'acp') {
          if (next.value.value.kind === 'stop') {
            yield { type: 'final', text: output, stopReason: next.value.value.stopReason, sessionId: actualId };
            return;
          }
          const event = acpEvent(next.value.value.update, secret(this.config));
          if (!event) continue;
          if (event.type === 'text' && event.text) {
            if (event.interim) {
              const retracted = event.retractText ?? (event.alreadyStreamed ? event.text : '');
              if (retracted) output = stripTrailingText(output, retracted);
            } else {
              output += event.text;
            }
          }
          yield { ...event, sessionId: actualId };
        } else {
          const event = next.value.value;
          if (event.type === 'error') throw new Error(event.text ?? 'ACP agent failed');
          if (event.type === 'final') {
            yield { ...event, text: output || event.text || '', sessionId: actualId };
            return;
          }
          if (event.type === 'text' && event.text) {
            if (event.interim) {
              const retracted = event.retractText ?? (event.alreadyStreamed ? event.text : '');
              if (retracted) output = stripTrailingText(output, retracted);
            } else {
              output += event.text;
            }
          }
          yield { ...event, sessionId: actualId };
        }
      }
    } catch (error) {
      if (signal?.aborted) {
        if (actualId && !shouldSkipRemoteCancel(signal)) {
          await this.cancel(actualId).catch(() => {
            /* best-effort remote cancel on abort */
          });
        }
        yield { type: 'final', text: output, stopReason: 'cancelled', ...(actualId ? { sessionId: actualId } : {}) };
      } else {
        if (queue.failure && actualId && this.connection?.signal.aborted === false) {
          const deadline = AbortSignal.timeout(5_000);
          await raceAbort(this.cancel(actualId, deadline), deadline).catch(() => {
            /* best-effort remote cancel when the event queue cannot accept more updates */
          });
        }
        yield { type: 'error', text: error instanceof Error ? error.message : String(error) };
      }
    } finally {
      if (actualId && this.queues.get(actualId) === queue) {
        this.queues.delete(actualId);
        this.cancelPermissions(actualId);
      }
      queue.finish();
    }
  }

  async cancel(sessionId: string, signal?: AbortSignal): Promise<void> {
    await this.connect(signal);
    const actualId = this.sessionIds.get(sessionId) ?? sessionId;
    await this.connection!.agent.notify(methods.agent.session.cancel, { sessionId: actualId });
    this.cancelPermissions(actualId);
  }

  async respond(sessionId: string, requestId: string, choice: string): Promise<void> {
    const actualId = this.sessionIds.get(sessionId) ?? sessionId;
    const key = permissionKey(actualId, requestId);
    const pending = this.permissions.get(key);
    if (!pending) throw new Error(`No pending ACP permission request ${requestId} for session ${actualId}`);
    this.permissions.delete(key);
    pending.resolve({ outcome: { outcome: 'selected', optionId: choice } });
  }

  async close(): Promise<void> {
    this.cancelPermissions();
    for (const queue of this.queues.values()) queue.finish();
    this.queues.clear();
    this.clearSessions();
    this.connection?.close();
    this.connection = undefined;
    this.connecting = undefined;
    await this.closeProcess();
    await this.transport.close();
  }

  private cancelPermissions(sessionId?: string): void {
    for (const [requestId, pending] of this.permissions) {
      if (sessionId !== undefined && pending.sessionId !== sessionId) continue;
      this.permissions.delete(requestId);
      pending.resolve({ outcome: { outcome: 'cancelled' } });
    }
  }

  private trackInFlight(sessionId: string, promise: Promise<unknown>): void {
    const settled = promise.then(
      () => {},
      () => {},
    );
    this.inFlightPrompts.set(sessionId, settled);
    void settled.finally(() => {
      if (this.inFlightPrompts.get(sessionId) === settled) this.inFlightPrompts.delete(sessionId);
    });
  }

  private clearSessions(): void {
    for (const session of new Set(this.activeSessions.values())) session.dispose();
    this.activeSessions.clear();
    this.loadedSessions.clear();
    this.inFlightPrompts.clear();
    this.sessionIds.clear();
    this.pumping.clear();
  }

  private rememberSessionCwd(sessionId: string, cwd: string): void {
    this.sessionCwds.delete(sessionId);
    this.sessionCwds.set(sessionId, cwd);
    while (this.sessionCwds.size > 500) {
      const oldest = this.sessionCwds.keys().next().value;
      if (oldest === undefined) break;
      this.sessionCwds.delete(oldest);
    }
  }

  private rememberLoadedSession(sessionId: string): void {
    this.loadedSessions.delete(sessionId);
    this.loadedSessions.add(sessionId);
    this.sessionIds.delete(sessionId);
    this.sessionIds.set(sessionId, sessionId);
    while (this.loadedSessions.size > 500) {
      const oldest = this.loadedSessions.values().next().value;
      if (oldest === undefined) break;
      this.loadedSessions.delete(oldest);
      this.sessionIds.delete(oldest);
    }
  }

  private rememberSession(alias: string, actualId: string, active: ActiveSession): void {
    this.activeSessions.delete(alias);
    this.activeSessions.delete(actualId);
    this.activeSessions.set(alias, active);
    this.activeSessions.set(actualId, active);
    this.sessionIds.delete(alias);
    this.sessionIds.delete(actualId);
    this.sessionIds.set(alias, actualId);
    this.sessionIds.set(actualId, actualId);
    while (this.activeSessions.size > 500) {
      const oldestKey = this.activeSessions.keys().next().value;
      if (oldestKey === undefined) break;
      const evicted = this.activeSessions.get(oldestKey);
      this.activeSessions.delete(oldestKey);
      this.sessionIds.delete(oldestKey);
      if (evicted && ![...this.activeSessions.values()].includes(evicted)) {
        evicted.dispose();
      }
    }
  }

  private pumpUpdates(actualId: string, active: ActiveSession): void {
    if (this.pumping.has(actualId)) return;
    this.pumping.add(actualId);
    void (async () => {
      try {
        while (this.activeSessions.get(actualId) === active) {
          const value = await active.nextUpdate();
          this.queues.get(actualId)?.push({ kind: 'acp', value });
          if (value.kind === 'stop') break;
        }
      } catch (error) {
        this.queues.get(actualId)?.push({
          kind: 'native',
          value: { type: 'error', text: error instanceof Error ? error.message : String(error) },
        });
      } finally {
        this.pumping.delete(actualId);
      }
    })();
  }

  private async connect(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw signal.reason ?? new Error('request aborted');
    if (!this.connecting) {
      if (this.connection && !this.connection.signal.aborted) return;
      this.connecting = this.open()
        .catch(async (error) => {
          this.connection?.close();
          this.connection = undefined;
          await this.closeProcess();
          throw error;
        })
        .finally(() => {
          this.connecting = undefined;
        });
      this.connecting.catch(() => {
        /* prevent unhandledRejection if all callers abort before connect settles */
      });
    }
    return raceAbort(this.connecting, signal);
  }

  private async open(): Promise<void> {
    this.clearSessions();
    await this.closeProcess();
    const stream = this.config.acpTransport === 'stdio' ? this.openStdio() : this.openWebSocket();
    const app = client({ name: 'dsh-knot' });
    app.onNotification(methods.client.session.update, ({ params }) => {
      if (!this.loadedSessions.has(params.sessionId) || this.activeSessions.has(params.sessionId)) return;
      const event = acpEvent(params.update, secret(this.config));
      if (event) this.queues.get(params.sessionId)?.push({ kind: 'native', value: event });
    });
    app.onRequest(methods.client.session.requestPermission, ({ params }) => {
      const queue = this.queues.get(params.sessionId);
      if (!queue || queue.failure) return { outcome: { outcome: 'cancelled' } };
      const requestId = params.toolCall.toolCallId;
      const key = permissionKey(params.sessionId, requestId);
      const previous = this.permissions.get(key);
      if (previous) {
        previous.resolve({ outcome: { outcome: 'cancelled' } });
        this.permissions.delete(key);
      }
      queue.push({
        kind: 'native',
        value: {
          type: 'approval',
          requestId,
          text: params.toolCall.title ?? 'Permission requested',
          choices: params.options.map((option) => option.optionId),
        },
      });
      return new Promise<RequestPermissionResponse>((resolve) => {
        this.permissions.set(key, { sessionId: params.sessionId, resolve });
      });
    });
    const connection = app.connect(stream);
    this.connection = connection;
    connection.closed.then(() => {
      if (this.connection !== connection) return;
      this.clearSessions();
      const closeErr = new Error('ACP connection closed');
      for (const queue of this.queues.values()) queue.fail(closeErr);
      this.cancelPermissions();
    });
    const initialized = await withTimeout(
      connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: 'dsh-knot', version: VERSION },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        _meta: { 'dsh-knot/interimRetraction': true },
      }),
      this.config.connectTimeoutMs ?? 30_000,
      'ACP initialize',
    );
    if (initialized.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(`Unsupported ACP protocol version ${initialized.protocolVersion}; expected ${PROTOCOL_VERSION}`);
    }
    this.capabilities = initialized.agentCapabilities;
  }

  private openWebSocket() {
    const host = urlHost(this.config.host ?? '127.0.0.1');
    const protocol = this.config.tls ? 'wss' : 'ws';
    const path = this.config.basePath ?? '/acp';
    const token = secret(this.config);
    return createWebSocketStream(`${protocol}://${host}:${this.config.port ?? 18_792}${path}`, {
      WebSocket,
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
    });
  }

  private openStdio() {
    if (this.config.transport !== 'local' || !this.config.acpCommand?.trim()) {
      throw new Error('ACP stdio requires local transport and acpCommand');
    }
    const child = spawn(this.config.acpCommand, this.config.acpArgs ?? [], {
      // ACP agents can write credentials and session content to stderr.
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    this.child = child;
    child.on('error', (error: NodeJS.ErrnoException) => {
      const failure = new Error(`ACP process error${error.code ? ` (${error.code})` : ''}`);
      child.stdin.destroy(failure);
      child.stdout.destroy(failure);
    });
    return ndJsonStream(
      Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
    );
  }

  private async closeProcess(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    child.stdin!.end();
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill();
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        child.off('exit', done);
        child.off('close', done);
        resolve();
      };
      const timer = setTimeout(done, 1000);
      timer.unref();
      child.once('exit', done);
      child.once('close', done);
    });
  }
}

function permissionKey(sessionId: string, requestId: string): string {
  return `${sessionId}\0${requestId}`;
}

function acpEvent(update: SessionUpdate, token?: string): AgentEvent | undefined {
  if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
    return { type: 'text', text: update.content.text };
  }
  if (update.sessionUpdate === 'agent_thought_chunk' && update.content.type === 'text') {
    const meta = update._meta;
    if (meta?.['dsh-knot/commentary'] === true) {
      const retractText =
        typeof meta['dsh-knot/retractText'] === 'string' && meta['dsh-knot/retractText']
          ? meta['dsh-knot/retractText']
          : undefined;
      return {
        type: 'text',
        text: update.content.text,
        interim: true,
        ...(meta['dsh-knot/alreadyStreamed'] === true || retractText ? { alreadyStreamed: true } : {}),
        ...(retractText ? { retractText } : {}),
      };
    }
    return { type: 'thought', text: update.content.text };
  }
  if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
    const inputPreview = toolInputPreview(update.rawInput, token);
    const status = update.status ?? (update.sessionUpdate === 'tool_call' ? 'pending' : undefined);
    return {
      type: 'tool',
      phase: status === 'in_progress' ? 'start' : status === 'pending' || status === undefined ? status : 'end',
      requestId: update.toolCallId,
      name: toolInputPreview(update.name, token),
      title: !update.name ? toolInputPreview(update.title, token) : undefined,
      ...(inputPreview ? { inputPreview } : {}),
      ...(update.status === 'failed' ? { failed: true } : {}),
    };
  }
  if (update.sessionUpdate === 'notice' && update.severity === 'error') {
    return { type: 'error', text: update.description ?? update.title };
  }
  return undefined;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string, signal?: AbortSignal): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const abort = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    if (signal?.aborted) reject(new Error(`${label} aborted`));
    else if (signal) {
      onAbort = () => reject(new Error(`${label} aborted`));
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([promise, abort]);
  } finally {
    clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}
