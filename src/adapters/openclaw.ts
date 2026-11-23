import { randomUUID } from 'node:crypto';
import { raceAbort, secret, shouldSkipRemoteCancel, urlHost } from '../config.js';
import { toolInputPreview } from '../policy/redact.js';
import { transportFor } from '../transports/http.js';
import type { AgentAdapter, AgentConfig, AgentEvent, AgentSession, Transport } from '../types.js';
import { VERSION } from '../version.js';
import { GatewayWebSocket } from './gateway-ws.js';
import { loadOrCreateIdentity, signClaim } from './openclaw-identity.js';

export class OpenClawAdapter implements AgentAdapter {
  readonly kind = 'openclaw' as const;
  private readonly transport: Transport;
  private readonly gateway: GatewayWebSocket;
  private ready = false;
  private connecting?: Promise<void>;

  constructor(
    readonly id: string,
    private readonly config: AgentConfig,
    transport?: Transport,
    gateway?: GatewayWebSocket,
  ) {
    this.transport = transport ?? transportFor(config);
    this.gateway = gateway ?? new GatewayWebSocket(config.connectTimeoutMs ?? 30_000);
  }

  async health(signal?: AbortSignal): Promise<Record<string, unknown>> {
    await this.connect(signal);
    return this.gateway.request('health', {}, remaining(15_000, signal), signal);
  }

  async listSessions(signal?: AbortSignal): Promise<AgentSession[]> {
    await this.connect(signal);
    const value = await this.gateway.request('sessions.list', {}, remaining(30_000, signal), signal);
    const rows = Array.isArray(value) ? value : (value.items ?? value.sessions ?? []);
    return (Array.isArray(rows) ? rows : [])
      .map((row: Record<string, any>) => ({
        id: String(row.sessionKey ?? row.key ?? row.id ?? row.sessionId ?? ''),
        ...(row.title === undefined && row.displayName === undefined
          ? {}
          : { title: String(row.title ?? row.displayName) }),
        ...(row.updatedAt === undefined ? {} : { updatedAt: row.updatedAt }),
      }))
      .filter((row: AgentSession) => row.id);
  }

  async *prompt(sessionId: string | undefined, text: string, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    await this.connect(signal);
    const subscription = this.gateway.subscribeEvents();
    const waitAbort = new AbortController();
    const onAbort = () => waitAbort.abort(signal?.reason ?? new Error('request aborted'));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    let output = '';
    try {
      if (sessionId) {
        await this.gateway.request(
          'sessions.create',
          {
            key: sessionId,
            ...(this.config.openclawAgentId ? { agentId: this.config.openclawAgentId } : {}),
            idempotencyKey: randomUUID(),
          },
          remaining(60_000, signal),
          signal,
        );
      }
      const started = await this.gateway.request(
        'agent',
        {
          message: text,
          ...(sessionId ? { sessionKey: sessionId } : {}),
          ...(this.config.openclawAgentId ? { agentId: this.config.openclawAgentId } : {}),
          idempotencyKey: randomUUID(),
        },
        remaining(60_000, signal),
        signal,
      );
      const runId = String(started.runId ?? started.run_id ?? started.id ?? '');
      const sessionKey = String(started.sessionKey ?? started.session_key ?? sessionId ?? '');
      if (!runId) throw new Error(`OpenClaw did not return a run id: ${JSON.stringify(started)}`);
      const aborted = new Promise<{ kind: 'aborted' }>((resolve) => {
        if (waitAbort.signal.aborted) resolve({ kind: 'aborted' });
        else waitAbort.signal.addEventListener('abort', () => resolve({ kind: 'aborted' }), { once: true });
      });
      let completed = this.gateway.request('agent.wait', { runId }, 1_800_000, waitAbort.signal);
      completed.catch(() => {});
      let next = subscription.next(waitAbort.signal);
      next.catch(() => {});
      while (true) {
        if (signal?.aborted) {
          if (!shouldSkipRemoteCancel(signal)) {
            await this.cancel(sessionKey).catch(() => {
              /* best-effort remote cancel on abort */
            });
          }
          return;
        }
        const result = await Promise.race([
          completed.then((value) => ({ kind: 'done' as const, value })),
          next.then((value) => ({ kind: 'event' as const, value })),
          aborted,
        ]);
        if (result.kind === 'aborted') {
          if (!shouldSkipRemoteCancel(signal)) {
            await this.cancel(sessionKey).catch(() => {
              /* best-effort remote cancel on abort */
            });
          }
          return;
        }
        if (result.kind === 'done') {
          const streamError = subscription.error?.();
          if (streamError) throw streamError;
          const rawStatus = String(result.value.status ?? 'completed').toLowerCase();
          if (rawStatus === 'pending' || rawStatus === 'timeout') {
            completed = this.gateway.request('agent.wait', { runId }, 1_800_000, waitAbort.signal);
            completed.catch(() => {});
            continue;
          }
          const textResult = textOf(
            result.value.output ??
              result.value.result ??
              result.value.message ??
              result.value.terminalReply ??
              result.value.terminalReceipt ??
              result.value,
          );
          if (rawStatus === 'error' || rawStatus === 'failed' || result.value.error !== undefined) {
            const errText =
              textOf(result.value.error) ||
              (typeof result.value.error === 'string' ? result.value.error : '') ||
              textResult ||
              `OpenClaw run ended with status "${rawStatus}"`;
            yield { type: 'error', text: errText, stopReason: rawStatus };
            return;
          }
          const stopReason = rawStatus === 'aborted' || rawStatus === 'cancelled' ? 'cancelled' : rawStatus;
          yield { type: 'final', text: textResult || output, stopReason };
          return;
        }
        next = subscription.next(waitAbort.signal);
        next.catch(() => {});
        if (result.value.done) throw new Error('OpenClaw event stream ended before the run completed');
        const frame = result.value.value;
        const payload = frame.payload ?? frame.data ?? frame;
        const eventRun = String(payload.runId ?? payload.run_id ?? '');
        if (eventRun && eventRun !== runId) continue;
        const eventName = String(payload.event ?? payload.type ?? frame.event ?? '');
        const nested =
          payload.data && typeof payload.data === 'object' ? (payload.data as Record<string, unknown>) : undefined;
        if (frame.event === 'agent' && payload.stream === 'tool') {
          if (eventRun === runId && nested && (nested.phase === 'start' || nested.phase === 'result')) {
            const requestId = nested.toolCallId;
            const inputPreview =
              nested.phase === 'start' ? toolInputPreview(nested.args, secret(this.config)) : undefined;
            yield {
              type: 'tool',
              phase: nested.phase === 'result' ? 'end' : 'start',
              name: typeof nested.name === 'string' && nested.name ? nested.name : 'tool',
              ...(inputPreview ? { inputPreview } : {}),
              ...(typeof requestId === 'string' && requestId ? { requestId } : {}),
              ...(nested.phase === 'result' && nested.isError === true ? { failed: true } : {}),
            };
          }
          continue;
        }
        const delta = textOf(
          payload.delta ??
            payload.textDelta ??
            payload.content ??
            nested?.delta ??
            nested?.textDelta ??
            nested?.content,
        );
        if (delta) {
          output += delta;
          yield { type: 'text', text: delta };
        }
        if (/approval|permission/.test(eventName)) {
          yield {
            type: 'approval',
            requestId: String(payload.requestId ?? payload.id ?? ''),
            text: String(payload.description ?? payload.command ?? 'Approval requested'),
            choices: [],
          };
        } else if (/tool/.test(eventName)) {
          yield {
            type: 'tool',
            phase: /end|complete|finish/.test(eventName) ? 'end' : 'start',
            name: String(payload.name ?? payload.toolName ?? 'tool'),
          };
        }
        if (sessionKey) (payload as Record<string, unknown>).sessionKey ??= sessionKey;
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
      waitAbort.abort();
      subscription.unsubscribe();
    }
  }

  async cancel(sessionId: string, signal?: AbortSignal): Promise<void> {
    await this.connect(signal);
    await this.gateway.request('sessions.abort', { key: sessionId }, remaining(30_000, signal), signal);
  }

  async close(): Promise<void> {
    this.ready = false;
    await this.gateway.close();
    await this.transport.close();
  }

  private async connect(signal?: AbortSignal): Promise<void> {
    if (this.ready && this.gateway.isOpen) return;
    if (signal?.aborted) throw signal.reason ?? new Error('request aborted');
    this.ready = false;
    if (!this.connecting) {
      this.connecting = this.handshake()
        .catch(async (error) => {
          await this.gateway.close();
          throw error;
        })
        .finally(() => {
          this.connecting = undefined;
        });
      this.connecting.catch(() => {
        /* prevent unhandledRejection if all callers abort before handshake settles */
      });
    }
    return raceAbort(this.connecting, signal);
  }

  private async handshake(): Promise<void> {
    const token = secret(this.config);
    if (!token)
      throw new Error(
        `${this.id}: configure the agent token in DSH Knot UI (or tokenEnv / OPENCLAW_GATEWAY_TOKEN) for the OpenClaw gateway`,
      );
    const host = urlHost(this.config.host ?? '127.0.0.1');
    const port = this.config.port ?? 18_789;
    const tls = this.config.tls === true;
    await this.gateway.openWebSocket({
      host,
      port,
      tls,
      path: this.config.basePath,
      origin: this.config.origin,
    });
    const identity = loadOrCreateIdentity(this.id);
    const challenge = await withTimeout(
      this.gateway.nextEvent(),
      this.config.connectTimeoutMs ?? 30_000,
      'OpenClaw pairing challenge',
    );
    if (challenge.done) throw new Error('OpenClaw closed before pairing completed');
    const event = challenge.value;
    if (event.event !== 'connect.challenge') throw new Error(`Unexpected OpenClaw handshake event: ${event.event}`);
    const signedAt = Number(event.payload?.ts);
    if (!Number.isSafeInteger(signedAt) || signedAt < 0) throw new Error('OpenClaw challenge is missing a valid ts');
    await this.pairAgain(identity, token, String(event.payload?.nonce ?? ''), signedAt);
    this.ready = true;
  }

  private async pairAgain(
    identity: ReturnType<typeof loadOrCreateIdentity>,
    token: string,
    nonce: string,
    signedAt: number,
  ): Promise<Record<string, any>> {
    const signature = signClaim(identity, nonce, token, signedAt);
    return this.gateway.request('connect', {
      minProtocol: 4,
      maxProtocol: 4,
      client: { id: 'cli', version: VERSION, platform: process.platform, mode: 'cli' },
      caps: ['tool-events'],
      role: 'operator',
      scopes: ['operator.admin', 'operator.read', 'operator.write', 'operator.approvals', 'operator.pairing'],
      auth: { token },
      device: { id: identity.deviceId, publicKey: identity.publicKey.x, signature, nonce, signedAt },
    });
  }
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textOf).join('');
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return textOf(row.text ?? row.content ?? row.output_text ?? row.output ?? row.message);
  }
  return '';
}

function remaining(ms: number, signal?: AbortSignal): number {
  if (signal?.aborted) throw new Error('request aborted');
  return ms;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
