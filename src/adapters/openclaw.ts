import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { raceAbort, secret, shouldSkipRemoteCancel, urlHost } from '../config.js';
import { requireSecureGateway } from '../policy/auth.js';
import { toolInputPreview } from '../policy/redact.js';
import { transportFor } from '../transports/http.js';
import type { AgentAdapter, AgentConfig, AgentEvent, AgentSession, Transport } from '../types.js';
import { VERSION } from '../version.js';
import { GatewayWebSocket } from './gateway-ws.js';
import { loadOrCreateIdentity, signClaim } from './openclaw-identity.js';

const MAX_THOUGHT_SNAPSHOT_LENGTH = 64_000;

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
    let sessionKey: string | undefined;
    let lastThought: { itemId?: string; snapshot?: string } | undefined;
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
      if (!runId) throw new Error(`OpenClaw did not return a run id: ${JSON.stringify(started)}`);
      sessionKey = String(started.sessionKey ?? started.session_key ?? sessionId ?? '');
      const completion = (async () => {
        try {
          while (true) {
            const value = await this.gateway.request('agent.wait', { runId }, 1_800_000, waitAbort.signal);
            const rawStatus = String(value.status ?? 'completed').toLowerCase();
            const waitExpired = rawStatus === 'timeout' && value.endedAt == null && value.stopReason == null;
            if (rawStatus !== 'pending' && !waitExpired) return { value, rawStatus };
            await delay(250, undefined, { signal: waitAbort.signal });
          }
        } catch (error) {
          return { error };
        } finally {
          // Seal the queue so the consumer drains previously received events before the terminal result.
          subscription.unsubscribe();
        }
      })();
      while (true) {
        const { done, value: frame } = await subscription.next(waitAbort.signal);
        waitAbort.signal.throwIfAborted();
        if (done) break;
        const payload = frame.payload ?? frame.data ?? frame;
        if (frame.event === 'exec.approval.requested' || frame.event === 'exec.approval.resolved') {
          const { id, request } = payload;
          if (typeof id !== 'string' || !id || !request) continue;
          const approvalRun = request.runId;
          if (approvalRun ? approvalRun !== runId : !sessionKey || request.sessionKey !== sessionKey) continue;
          if (frame.event === 'exec.approval.resolved') yield { type: 'approval', phase: 'end', requestId: id };
          else {
            yield {
              type: 'approval',
              requestId: id,
              text:
                toolInputPreview(request.commandPreview ?? request.command, secret(this.config)) ??
                'Approval requested',
              choices: [],
            };
          }
          continue;
        }
        const eventRun = String(payload.runId ?? payload.run_id ?? '');
        if (eventRun !== runId) continue;
        const eventName = String(payload.event ?? payload.type ?? frame.event ?? '');
        const nested =
          payload.data && typeof payload.data === 'object' ? (payload.data as Record<string, unknown>) : undefined;
        if (frame.event === 'agent' && payload.stream === 'thinking') {
          if (nested) {
            const itemId = typeof nested.itemId === 'string' ? nested.itemId : undefined;
            const snapshot = typeof nested.text === 'string' ? nested.text : undefined;
            let thought = typeof nested.delta === 'string' ? nested.delta : snapshot;
            const previous = lastThought?.itemId === itemId ? lastThought?.snapshot : undefined;
            // OpenClaw can resend the full snapshot at the message boundary as its delta.
            if (snapshot && previous && thought?.endsWith(snapshot) && snapshot.startsWith(previous)) {
              thought = snapshot.slice(previous.length);
            }
            if (thought) {
              const separator = itemId && lastThought?.itemId && lastThought.itemId !== itemId ? '\n\n' : '';
              yield { type: 'thought', text: separator + thought };
            }
            lastThought = {
              itemId,
              snapshot: snapshot && snapshot.length <= MAX_THOUGHT_SNAPSHOT_LENGTH ? snapshot : undefined,
            };
          }
          continue;
        }
        if (frame.event === 'agent' && payload.stream === 'tool') {
          if (nested && (nested.phase === 'start' || nested.phase === 'result')) {
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
        if (/tool/.test(eventName)) {
          yield {
            type: 'tool',
            phase: /end|complete|finish/.test(eventName) ? 'end' : 'start',
            name: String(payload.name ?? payload.toolName ?? 'tool'),
          };
        }
      }
      const terminal = await completion;
      if ('error' in terminal) throw terminal.error;
      const { value, rawStatus } = terminal;
      const textResult = textOf(
        value.output ?? value.result ?? value.message ?? value.terminalReply ?? value.terminalReceipt ?? value,
      );
      if (rawStatus === 'error' || rawStatus === 'failed' || rawStatus === 'timeout' || value.error !== undefined) {
        if (rawStatus === 'timeout' && textResult.startsWith(output) && textResult.length > output.length) {
          yield { type: 'text', text: textResult.slice(output.length) };
        }
        const errText =
          textOf(value.error) ||
          (rawStatus !== 'timeout' ? textResult : '') ||
          `OpenClaw run ended with status "${rawStatus}"`;
        yield { type: 'error', text: errText, stopReason: rawStatus };
        return;
      }
      const stopReason = rawStatus === 'aborted' || rawStatus === 'cancelled' ? 'cancelled' : rawStatus;
      yield { type: 'final', text: textResult || output, stopReason };
      return;
    } catch (error) {
      if (!signal?.aborted || sessionKey === undefined) throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      waitAbort.abort();
      subscription.unsubscribe();
    }
    if (sessionKey && !shouldSkipRemoteCancel(signal)) {
      await this.cancel(sessionKey).catch(() => {
        /* best-effort remote cancel on abort */
      });
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
    requireSecureGateway(this.config);
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
