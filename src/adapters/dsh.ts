import { randomUUID } from 'node:crypto';
import { raceAbort, secret, shouldSkipRemoteCancel } from '../config.js';
import { requireSecureGateway } from '../policy/auth.js';
import { transportFor } from '../transports/http.js';
import type { AgentAdapter, AgentConfig, AgentEvent, AgentSession, HttpResponse, Transport } from '../types.js';

const SESSION_WAIT_MS = 30_000;

export class DshAdapter implements AgentAdapter {
  readonly kind = 'dsh' as const;
  private readonly transport: Transport;
  private cookie?: string;
  private connecting?: Promise<void>;
  private readonly cursors = new Map<string, number>();
  private readonly sessionIds = new Map<string, string>();

  constructor(
    readonly id: string,
    private readonly config: AgentConfig,
    transport?: Transport,
  ) {
    this.transport = transport ?? transportFor(config);
  }

  async health(signal?: AbortSignal): Promise<Record<string, unknown>> {
    const value = await this.rpc('list', {}, signal);
    return { ok: true, sessions: Array.isArray(value.items) ? value.items.length : 0 };
  }

  async listSessions(signal?: AbortSignal): Promise<AgentSession[]> {
    const value = await this.rpc('list', {}, signal);
    return (value.items ?? [])
      .map((item: any) => ({
        id: String(item.sessionId ?? item.id ?? ''),
        title: item.title ? String(item.title) : undefined,
        updatedAt: item.lastActivity ?? item.updatedAt,
      }))
      .filter((item: AgentSession) => item.id);
  }

  async *prompt(sessionId: string | undefined, text: string, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    const requestedId = sessionId ?? randomUUID();
    let actualId = this.sessionIds.get(requestedId) ?? requestedId;
    let output = '';
    try {
      if (!this.sessionIds.has(requestedId)) {
        let existingRemote = false;
        if (sessionId) {
          const remoteSessions = await this.listSessions(signal);
          existingRemote = remoteSessions.some((item) => item.id === sessionId);
        }
        if (existingRemote) {
          actualId = sessionId!;
          if (!this.cursors.has(actualId)) {
            const page = await this.rpc(
              'events',
              { address: { kind: 'session', sessionId: actualId }, maxMessages: 1 },
              signal,
            );
            const initialCursor = Number(page.cursor ?? maxRecordSeq(page.records ?? []));
            rememberBounded(
              this.cursors,
              actualId,
              Number.isFinite(initialCursor) && initialCursor > 0 ? initialCursor : 0,
            );
          }
          rememberBounded(this.sessionIds, requestedId, actualId);
        } else {
          const created = await this.rpc(
            'create',
            {
              sessionId: requestedId,
              ...(this.config.dshCwd ? { cwd: this.config.dshCwd } : {}),
            },
            signal,
          );
          actualId = String(created.sessionId ?? requestedId);
          if (sessionId && actualId !== sessionId) {
            throw new Error(
              `Remote DSH created a different session "${actualId}" instead of continuing "${sessionId}"`,
            );
          }
          rememberBounded(this.sessionIds, requestedId, actualId);
          rememberBounded(this.sessionIds, actualId, actualId);
        }
      }
      yield { type: 'text', text: '', sessionId: actualId };
      if (this.config.model) {
        await this.rpc(
          'selectModel',
          {
            sessionId: actualId,
            provider: this.config.dshProvider ?? 'openai',
            model: this.config.model,
            ...(this.config.reasoningEffort ? { reasoningEffort: this.config.reasoningEffort } : {}),
          },
          signal,
        );
      }
      const requestId = randomUUID();
      await this.rpc(
        'prompt',
        {
          requestId,
          sessionId: actualId,
          mode: 'queue',
          content: [{ type: 'text', text }],
          clientTimeZone: 'UTC',
        },
        signal,
      );

      while (true) {
        const afterSeq = this.cursors.get(actualId) ?? 0;
        const waited = await this.rpc(
          'wait',
          {
            sessionId: actualId,
            timeoutMs: SESSION_WAIT_MS,
            afterSeq,
            maxMessages: 20,
          },
          signal,
        );
        const rawRecords = Array.isArray(waited.output?.records) ? waited.output.records : [];
        const records = [...rawRecords]
          .filter((record: any) => {
            const seq = recordSeq(record);
            return seq === undefined || seq > afterSeq;
          })
          .sort((a: any, b: any) => (recordSeq(a) ?? 0) - (recordSeq(b) ?? 0));
        for (const record of records) {
          const text = assistantText(record);
          if (text && text !== output) {
            const delta = text.startsWith(output) ? text.slice(output.length) : text;
            output = text;
            if (delta) yield { type: 'text', text: delta, sessionId: actualId };
          }
        }
        const parsedCursor = Number(waited.state?.cursor);
        const cursor = Number.isFinite(parsedCursor) ? parsedCursor : afterSeq;
        rememberBounded(this.cursors, actualId, Math.max(afterSeq, cursor));
        if (records.length === 0 && waited.reason !== 'timeout') {
          const page = await this.rpc(
            'events',
            {
              address: { kind: 'session', sessionId: actualId },
              throughSeq: cursor,
              maxMessages: 50,
            },
            signal,
          );
          const turnRecords = (page.records ?? []).filter((record: any) => {
            const seq = recordSeq(record);
            return seq === undefined || seq > afterSeq;
          });
          const failure = durableFailure(turnRecords);
          if (failure) throw new Error(failure);
        }
        if (waited.reason !== 'timeout') {
          const reason = String(waited.reason ?? 'idle');
          if (reason === 'input-required' || reason === 'input_required') {
            yield {
              type: 'error',
              text: 'Remote DSH session requires interactive user input (input-required)',
              stopReason: reason,
              sessionId: actualId,
            };
            return;
          }
          yield { type: 'final', text: output, stopReason: reason, sessionId: actualId };
          return;
        }
      }
    } catch (error) {
      if (signal?.aborted) {
        if (!shouldSkipRemoteCancel(signal)) {
          await this.cancel(actualId).catch(() => {
            /* best-effort remote cancel on abort */
          });
        }
        yield { type: 'final', text: output, stopReason: 'cancelled', sessionId: actualId };
        return;
      }
      yield { type: 'error', text: error instanceof Error ? error.message : String(error) };
    }
  }

  async cancel(sessionId: string, signal?: AbortSignal): Promise<void> {
    await this.rpc('cancel', { sessionId: this.sessionIds.get(sessionId) ?? sessionId }, signal);
  }

  async close(): Promise<void> {
    await this.transport.close();
  }

  private async connect(signal?: AbortSignal): Promise<void> {
    if (this.cookie) return;
    if (signal?.aborted) throw signal.reason ?? new Error('request aborted');
    if (!this.connecting) {
      this.connecting = (async () => {
        const token = secret(this.config);
        if (!token) throw new Error(`${this.id}: a dsh web launch token is required (token or tokenEnv)`);
        requireSecureGateway(this.config);
        const response = await this.transport.request({
          path: `/connect?token=${encodeURIComponent(token)}&interactions=none`,
        });
        if (response.status !== 302) throw new Error(`DSH /connect returned HTTP ${response.status}: ${response.text}`);
        const header = response.headers['set-cookie'];
        const cookie = Array.isArray(header) ? header[0] : header;
        const pair = cookie?.split(';', 1)[0]?.trim();
        if (!pair) throw new Error('DSH /connect did not return an API cookie');
        this.cookie = pair;
      })().finally(() => {
        this.connecting = undefined;
      });
      this.connecting.catch(() => {
        /* prevent unhandledRejection if all callers abort before connect settles */
      });
    }
    return raceAbort(this.connecting, signal);
  }

  private async rpc(
    method: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    retried = false,
  ): Promise<any> {
    await this.connect(signal);
    requireSecureGateway(this.config);
    let response: HttpResponse;
    try {
      response = await this.transport.request({
        method: 'POST',
        path: `/api/session/${method}`,
        ...(method === 'wait' ? { responseWaitMs: SESSION_WAIT_MS } : {}),
        headers: { Cookie: this.cookie! },
        body: {
          type: 'client-request',
          rpcId: randomUUID(),
          method: `session/${method}`,
          payload: { args: method === 'list' ? { _request: args } : { request: args } },
        },
        signal,
      });
    } catch (error) {
      if (!retried && error instanceof Error && /^HTTP (?:401|403):/.test(error.message)) {
        this.cookie = undefined;
        return this.rpc(method, args, signal, true);
      }
      throw error;
    }
    let envelope: any;
    try {
      envelope = JSON.parse(response.text);
    } catch {
      throw new Error(`DSH returned non-JSON HTTP ${response.status}: ${response.text.slice(0, 500)}`);
    }
    const result = envelope.result;
    if (result?.ok !== true) {
      const error = result?.error;
      throw new Error(`${error?.code ?? 'dsh/rpc'}: ${error?.message ?? response.text}`);
    }
    return result.value;
  }
}

function rememberBounded<K, V>(map: Map<K, V>, key: K, value: V, limit = 500): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function durableFailure(records: any[]): string | undefined {
  for (const record of records) {
    const event = record?.event ?? record;
    if (event?.type === 'turn/end' && event.data?.reason?.kind === 'error') {
      return String(event.data.reason.error?.message ?? 'Remote DSH turn failed');
    }
    if (event?.type === 'assistant/attempt') {
      for (const frame of event.data?.stream ?? []) {
        const reason = frame?.chunk?.reason;
        if (frame?.chunk?.type === 'finish' && reason?.kind === 'error') {
          return String(reason.failure?.message ?? 'Remote DSH model attempt failed');
        }
      }
    }
  }
  return undefined;
}

function recordSeq(record: any): number | undefined {
  const seq = record?.event?.seq ?? record?.seq;
  return typeof seq === 'number' && Number.isFinite(seq) ? seq : undefined;
}

function maxRecordSeq(records: any[]): number {
  let max = 0;
  for (const record of records) {
    const seq = recordSeq(record);
    if (seq !== undefined && seq > max) max = seq;
  }
  return max;
}

function assistantText(record: any): string {
  const event = record?.event ?? record;
  if (event?.type !== 'assistant/message') return '';
  const content = event.data?.message?.content ?? event.data?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (part?.type === 'text' ? String(part.text ?? '') : '')).join('');
}
