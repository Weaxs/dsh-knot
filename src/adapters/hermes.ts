import { randomUUID } from 'node:crypto';
import { secret } from '../config.js';
import { transportFor } from '../transports/http.js';
import type { AgentAdapter, AgentConfig, AgentEvent, AgentSession, Transport } from '../types.js';
import { readSse } from './sse.js';

export class HermesAdapter implements AgentAdapter {
  readonly kind = 'hermes' as const;
  private readonly transport: Transport;
  private readonly runs = new Map<string, string>();

  constructor(
    readonly id: string,
    private readonly config: AgentConfig,
    transport?: Transport,
  ) {
    this.transport = transport ?? transportFor(config);
  }

  async health(signal?: AbortSignal): Promise<Record<string, unknown>> {
    const models = await this.json('/v1/models', { signal });
    if (models?.object !== 'list' || !Array.isArray(models.data)) {
      throw new Error('Hermes returned an invalid model list from /v1/models');
    }
    return this.json('/health', { signal });
  }

  async listSessions(signal?: AbortSignal): Promise<AgentSession[]> {
    // The Runs API cannot resume sessions owned by another Hermes surface.
    const value = await this.json('/api/sessions?source=api_server', { signal });
    const rows = Array.isArray(value)
      ? value
      : Array.isArray(value.items)
        ? value.items
        : Array.isArray(value.sessions)
          ? value.sessions
          : [];
    return rows
      .map((row: Record<string, unknown>) => ({
        id: String(row.session_id ?? row.id ?? ''),
        ...(row.title === undefined && row.preview === undefined ? {} : { title: String(row.title ?? row.preview) }),
        ...(row.last_active === undefined && row.updated_at === undefined
          ? {}
          : { updatedAt: String(row.last_active ?? row.updated_at) }),
      }))
      .filter((row: AgentSession) => row.id);
  }

  async *prompt(sessionId: string | undefined, text: string, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    const id = sessionId ?? `dsh_${randomUUID()}`;
    const accepted = await this.json('/v1/runs', {
      method: 'POST',
      body: { input: text, session_id: id, ...(this.config.model ? { model: this.config.model } : {}) },
      headers: { 'Idempotency-Key': randomUUID() },
      signal,
    });
    const runId = String(accepted.run_id ?? '');
    if (!runId) throw new Error(`Hermes did not return a run_id: ${JSON.stringify(accepted)}`);
    this.rememberRun(id, runId);
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
        const type = String(event.type ?? frame.event ?? '');
        const textDelta = textOf(event.delta ?? event.text_delta ?? event.content);
        if (textDelta) {
          output += textDelta;
          yield { type: 'text', text: textDelta };
        }
        if (type.includes('tool')) {
          yield {
            type: 'tool',
            phase: /complete|end|finish/.test(type) ? 'end' : 'start',
            name: String(event.name ?? event.tool_name ?? event.tool ?? 'tool'),
          };
        }
        if (
          /approval|permission/.test(type) &&
          !/responded|resolved|completed|approved|denied|rejected|cancelled/.test(type)
        ) {
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
      else if (state)
        yield {
          type: 'error',
          text: String(status.error ?? `Hermes stream ended while run was ${state}`),
          stopReason: state,
        };
    }
  }

  async cancel(sessionId: string, signal?: AbortSignal): Promise<void> {
    const runId = this.runs.get(sessionId);
    if (!runId) throw new Error(`No active Hermes run is recorded for session ${sessionId}`);
    await this.json(`/v1/runs/${encodeURIComponent(runId)}/stop`, { method: 'POST', body: {}, signal });
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
    await this.transport.close();
  }

  private rememberRun(sessionId: string, runId: string): void {
    this.runs.delete(sessionId);
    this.runs.set(sessionId, runId);
    while (this.runs.size > 500) {
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
      throw new Error(`Hermes returned non-JSON HTTP ${response.status}: ${response.text.slice(0, 500)}`);
    }
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
