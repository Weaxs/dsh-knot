import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { raceAbort, secret, shouldSkipRemoteCancel } from '../config.js';
import { toolInputPreview } from '../policy/redact.js';
import { transportFor } from '../transports/http.js';
import type {
  AgentAdapter,
  AgentConfig,
  AgentEvent,
  AgentPromptOptions,
  AgentSession,
  AgentTranscriptMessage,
  Transport,
} from '../types.js';
import { readSse } from './sse.js';

const MAX_TRANSCRIPT_MESSAGES = 200;
const MAX_TRACKED_RUNS = 500;
const STOP_TIMEOUT_MS = 4_000;
const TERMINAL_RUN_STATUSES = new Set(['cancelled', 'canceled', 'completed', 'failed', 'interrupted']);

export class HermesAdapter implements AgentAdapter {
  readonly kind = 'hermes' as const;
  private readonly transport: Transport;
  private readonly closing = new AbortController();
  private readonly admissions = new Map<string, Promise<string>>();
  private readonly runs = new Map<string, string>();

  constructor(
    readonly id: string,
    private readonly config: AgentConfig,
    transport?: Transport,
  ) {
    this.transport = transport ?? transportFor(config);
  }

  async health(signal?: AbortSignal): Promise<Record<string, unknown>> {
    const capabilities = await this.json('/v1/capabilities', { signal });
    const features = capabilities?.features;
    if (
      capabilities?.object !== 'hermes.api_server.capabilities' ||
      features?.run_submission !== true ||
      features.run_status !== true ||
      features.run_events_sse !== true ||
      features.run_stop !== true
    ) {
      throw new Error('Hermes API Server does not advertise the required Runs API capabilities');
    }
    return this.json('/health', { signal });
  }

  async listSessions(signal?: AbortSignal): Promise<AgentSession[]> {
    // The Runs API cannot resume sessions owned by another Hermes surface.
    const value = await this.json('/api/sessions?source=api_server', { signal });
    const rows = Array.isArray(value) ? value : (value?.data ?? value?.items ?? value?.sessions);
    if (!Array.isArray(rows)) throw new Error('Hermes returned an invalid session list');
    return rows
      .map((row: Record<string, unknown>) => {
        const updatedAt =
          typeof row.last_active === 'number' ? row.last_active * 1_000 : (row.last_active ?? row.updated_at);
        return {
          id: String(row.session_id ?? row.id ?? ''),
          ...(row.title === undefined && row.preview === undefined ? {} : { title: String(row.title ?? row.preview) }),
          ...(typeof updatedAt === 'number' || typeof updatedAt === 'string' ? { updatedAt } : {}),
        };
      })
      .filter((row: AgentSession) => row.id);
  }

  async getSessionMessages(sessionId: string, signal?: AbortSignal): Promise<AgentTranscriptMessage[]> {
    const value = await this.json(`/api/sessions/${encodeURIComponent(sessionId)}/messages?inline_images=false`, {
      signal,
    });
    const rows: unknown = value?.data;
    if (!Array.isArray(rows)) throw new Error('Hermes returned an invalid session transcript');

    const messages: AgentTranscriptMessage[] = [];
    const ids = new Set<string>();
    // shortcut: keep a recent message window until the chat supports loading older pages.
    for (let index = rows.length - 1; index >= 0 && messages.length < MAX_TRANSCRIPT_MESSAGES; index--) {
      const row = rows[index];
      if (row?.role !== 'user' && row?.role !== 'assistant') continue;
      const text = transcriptText(row.content);
      if (!text.trim()) continue;
      const remoteId = row.id;
      const candidate =
        (typeof remoteId === 'string' && remoteId.length > 0) || Number.isSafeInteger(remoteId)
          ? `message:${remoteId}`
          : '';
      const id = candidate && !ids.has(candidate) ? candidate : `row:${index}`;
      ids.add(id);
      messages.push({ id, role: row.role, text });
    }
    return messages.reverse();
  }

  async *prompt(
    sessionId: string | undefined,
    text: string,
    signal?: AbortSignal,
    options?: AgentPromptOptions,
  ): AsyncIterable<AgentEvent> {
    const id = sessionId ?? `dsh_${randomUUID()}`;
    const runId = await this.admitRun(id, text, signal, options);
    signal?.throwIfAborted();
    let terminal = false;
    let output = '';
    const response = await this.transport.stream({
      path: `/v1/runs/${encodeURIComponent(runId)}/events`,
      headers: this.headers(),
      signal,
    });
    try {
      for await (const frame of readSse(response)) {
        if (frame.data === '[DONE]') break;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(frame.data);
        } catch {
          continue;
        }
        const type = String(event.event ?? event.type ?? frame.event ?? '');
        const isApproval = /approval|permission/.test(type);
        if (type.startsWith('tool.') && !isApproval) {
          const started = /^tool\.start(?:ed)?$/.test(type);
          const ended = /^tool\.(?:complete(?:d)?|end(?:ed)?|finish(?:ed)?|failed)$/.test(type);
          if (!started && !ended) continue;
          const name = event.tool ?? event.name ?? event.tool_name;
          const requestId = event.tool_call_id;
          const inputPreview =
            started && typeof event.preview === 'string'
              ? toolInputPreview(event.preview, secret(this.config))
              : undefined;
          yield {
            type: 'tool',
            phase: ended ? 'end' : 'start',
            name: typeof name === 'string' && name ? name : 'tool',
            ...(inputPreview ? { inputPreview } : {}),
            ...(typeof requestId === 'string' && requestId ? { requestId } : {}),
            ...(ended && (type === 'tool.failed' || event.error === true) ? { failed: true } : {}),
          };
          continue;
        }
        const textDelta = textOf(event.delta ?? event.text_delta ?? event.content);
        if (textDelta) {
          output += textDelta;
          yield { type: 'text', text: textDelta };
        }
        if (isApproval && !/responded|resolved|completed|approved|denied|rejected|cancelled/.test(type)) {
          const requestId = String(event.request_id ?? event.id ?? frame.id ?? '');
          yield {
            type: 'approval',
            requestId,
            text: String(event.description ?? event.command ?? 'Approval requested'),
            choices: stringChoices(event.choices),
          };
        }
        if (/^run\.(completed|failed|cancelled|interrupted)$/.test(type)) {
          terminal = true;
          const finalText = textOf(event.output_text ?? event.output ?? event.response ?? event.message);
          if (finalText && !output.endsWith(finalText)) output = finalText;
          if (type === 'run.cancelled') {
            yield { type: 'final', text: output || finalText, stopReason: 'cancelled' };
            break;
          }
          const failed = type !== 'run.completed' || event.completed === false || event.error !== undefined;
          yield failed
            ? {
                type: 'error',
                text: String(event.error ?? event.turn_exit_reason ?? `Hermes run ended with ${type}`),
                stopReason: type,
              }
            : { type: 'final', text: output || finalText, stopReason: type };
          break;
        }
      }
    } finally {
      response.destroy();
    }
    if (!terminal && !signal?.aborted) {
      const status = await this.status(runId, signal);
      const state = String(status.status ?? '');
      const finalText = textOf(status.output_text ?? status.output ?? status.response ?? status.message);
      if (state === 'completed') yield { type: 'final', text: finalText || output, stopReason: state };
      else if (state === 'cancelled' || state === 'canceled')
        yield { type: 'final', text: finalText || output, stopReason: 'cancelled' };
      else
        yield {
          type: 'error',
          text: String(
            status.error ?? (state ? `Hermes stream ended while run was ${state}` : 'Hermes returned no run status'),
          ),
          stopReason: state,
        };
    }
  }

  async cancel(sessionId: string, signal?: AbortSignal): Promise<void> {
    const stopSignal = AbortSignal.any([
      this.closing.signal,
      AbortSignal.timeout(STOP_TIMEOUT_MS),
      ...(signal ? [signal] : []),
    ]);
    try {
      stopSignal.throwIfAborted();
      const admission = this.admissions.get(sessionId);
      const runId = admission ? await raceAbort(admission, stopSignal) : this.runs.get(sessionId);
      if (!runId) throw new Error('The run ID is unavailable');
      const acknowledgement = await this.json(`/v1/runs/${encodeURIComponent(runId)}/stop`, {
        method: 'POST',
        body: {},
        signal: stopSignal,
      });
      if (TERMINAL_RUN_STATUSES.has(acknowledgement.status)) return;
      while (true) {
        const state = await this.status(runId, stopSignal);
        if (TERMINAL_RUN_STATUSES.has(String(state.status))) return;
        await delay(250, undefined, { signal: stopSignal });
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Hermes remote stop is unconfirmed: ${detail}`, { cause: error });
    }
  }

  async respond(sessionId: string, requestId: string, choice: string, signal?: AbortSignal): Promise<void> {
    const runId = this.runs.get(sessionId);
    if (!runId) throw new Error(`No active Hermes run is recorded for session ${sessionId}`);
    await this.json(`/v1/runs/${encodeURIComponent(runId)}/approval`, {
      method: 'POST',
      body: { request_id: requestId, choice },
      signal,
    });
  }

  async close(): Promise<void> {
    this.closing.abort(new Error('Hermes adapter closed'));
    await this.transport.close();
  }

  private async admitRun(
    id: string,
    text: string,
    signal?: AbortSignal,
    options?: AgentPromptOptions,
  ): Promise<string> {
    signal?.throwIfAborted();
    if (!this.admissions.has(id) && this.admissions.size >= MAX_TRACKED_RUNS) {
      throw new Error('Too many pending Hermes runs');
    }
    const controller = new AbortController();
    const admissionSignal = AbortSignal.any([
      controller.signal,
      this.closing.signal,
      AbortSignal.timeout(this.config.connectTimeoutMs ?? 15_000),
    ]);
    admissionSignal.throwIfAborted();
    const abortAdmission = () => {
      // The manager needs the admission response's run ID to send a remote stop.
      if (!shouldSkipRemoteCancel(signal)) controller.abort(signal?.reason);
    };
    signal?.addEventListener('abort', abortAdmission, { once: true });
    this.runs.delete(id);
    const admission = this.json('/v1/runs', {
      method: 'POST',
      body: { input: text, session_id: id, ...(this.config.model ? { model: this.config.model } : {}) },
      headers: { 'Idempotency-Key': options?.idempotencyKey ?? randomUUID() },
      signal: admissionSignal,
    }).then((accepted) => {
      const runId = accepted?.run_id;
      if (typeof runId !== 'string' || !runId) throw new Error('Hermes did not return a run_id');
      return runId;
    });
    this.admissions.set(id, admission);
    try {
      const runId = await admission;
      if (this.admissions.get(id) === admission) this.rememberRun(id, runId);
      return runId;
    } finally {
      signal?.removeEventListener('abort', abortAdmission);
      if (this.admissions.get(id) === admission) this.admissions.delete(id);
    }
  }

  private rememberRun(sessionId: string, runId: string): void {
    this.runs.delete(sessionId);
    this.runs.set(sessionId, runId);
    while (this.runs.size > MAX_TRACKED_RUNS) {
      const oldest = this.runs.keys().next().value;
      if (oldest === undefined) break;
      this.runs.delete(oldest);
    }
  }

  private async status(runId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.json(`/v1/runs/${encodeURIComponent(runId)}`, { signal });
  }

  private headers(): Record<string, string> {
    const token = secret(this.config);
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  private async json(
    path: string,
    options: { method?: string; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal } = {},
  ): Promise<Record<string, any>> {
    const response = await this.transport.request({
      path,
      method: options.method,
      body: options.body,
      headers: { ...this.headers(), ...options.headers },
      signal: options.signal,
    });
    try {
      return JSON.parse(response.text);
    } catch {
      throw new Error(`Hermes returned non-JSON HTTP ${response.status}`);
    }
  }
}

function transcriptText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (block) =>
        (block?.type === 'text' || block?.type === 'input_text' || block?.type === 'output_text') &&
        typeof block.text === 'string',
    )
    .map((block) => block.text)
    .join('');
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

function stringChoices(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((choice) =>
      typeof choice === 'string'
        ? choice
        : String((choice as Record<string, unknown>)?.id ?? (choice as Record<string, unknown>)?.choice ?? ''),
    )
    .filter(Boolean);
}
