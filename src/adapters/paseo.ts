import { randomUUID } from 'node:crypto';
import { createPaseoApi, type PaseoAgentTimelineEvent, type PaseoApi } from '@getpaseo/client';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { AsyncQueue } from '../async-queue.js';
import { raceAbort, secret, shouldSkipRemoteCancel, urlHost } from '../config.js';
import { requireSecureGateway } from '../policy/auth.js';
import { redactText, toolInputPreview } from '../policy/redact.js';
import type { AgentAdapter, AgentConfig, AgentEvent, AgentSession } from '../types.js';

const OWNER_LABEL = 'dsh-knot';
const MAX_ACTIVE_TURNS = 32;

interface Turn {
  events: AsyncQueue<AgentEvent>;
  terminal: Promise<void>;
  started: Promise<void>;
  submitted: boolean;
  finished: boolean;
  remoteId?: string;
  permissions: Map<string, Map<string, 'allow' | 'deny'>>;
}

export class PaseoAdapter implements AgentAdapter {
  readonly kind = 'paseo' as const;
  private readonly closing = new AbortController();
  private readonly turns = new Map<string, Turn>();
  private connection?: { daemon: DaemonClient; api: PaseoApi };

  constructor(
    readonly id: string,
    private readonly config: AgentConfig,
  ) {}

  async listProviders(signal?: AbortSignal) {
    const { api } = await this.connect(signal);
    const result = await raceAbort(api.providers.snapshot(), this.deadline(signal)).catch((error: unknown) => {
      throw this.failure(error);
    });
    return result.entries
      .filter((entry) => entry.enabled && entry.status === 'ready')
      .map((entry) => ({ id: entry.provider, label: entry.label ?? entry.provider }));
  }

  async health(signal?: AbortSignal): Promise<Record<string, unknown>> {
    const providers = await this.listProviders(signal);
    if (!providers.some((provider) => provider.id === this.config.paseoProvider)) {
      throw new Error('The configured provider is unavailable on this Paseo daemon');
    }
    return { ok: true, protocol: 'paseo', provider: this.config.paseoProvider };
  }

  async listSessions(signal?: AbortSignal): Promise<AgentSession[]> {
    const { api } = await this.connect(signal);
    const result = await raceAbort(
      api.agents.list({
        filter: { labels: { [OWNER_LABEL]: this.id } },
        sort: [{ key: 'updated_at', direction: 'desc' }],
        page: { limit: 100 },
        timeout: this.config.connectTimeoutMs ?? 15_000,
      }),
      this.deadline(signal),
    ).catch((error: unknown) => {
      throw this.failure(error);
    });
    return result.entries.flatMap(({ agent }) =>
      this.owns(agent) && !agent.archivedAt
        ? [{ id: agent.id, title: agent.title ?? undefined, cwd: agent.cwd, updatedAt: agent.updatedAt }]
        : [],
    );
  }

  async *prompt(sessionId: string | undefined, text: string, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    const operation = this.signal(signal);
    const { daemon, api } = await this.connect(operation);
    const setup = this.deadline(operation);
    const id = sessionId ?? randomUUID();
    if (this.turns.has(id)) throw new Error('This Paseo session is already running a Knot turn');
    if (this.turns.size >= MAX_ACTIVE_TURNS) throw new Error('Too many active Paseo turns');
    const events = new AsyncQueue<AgentEvent>(1_024, 'error');
    let confirm!: () => void;
    let reject!: (error: Error) => void;
    const terminal = new Promise<void>((resolve, fail) => {
      confirm = resolve;
      reject = fail;
    });
    void terminal.catch(() => {});
    let accept!: () => void;
    const started = new Promise<void>((resolve) => {
      accept = resolve;
    });
    const turn: Turn = { events, terminal, started, submitted: false, finished: false, permissions: new Map() };
    this.turns.set(id, turn);
    const messageId = randomUUID();
    let admitted = false;
    const finish = (error?: Error, confirmed = false, cancelled = false) => {
      if (turn.finished) return;
      turn.finished = true;
      if (confirmed) confirm();
      else reject(error ?? new Error('Paseo turn ended without confirmation'));
      if (error) events.fail(error);
      else {
        events.push({ type: 'final', stopReason: cancelled ? 'cancelled' : 'end_turn', sessionId: id });
        events.finish();
      }
    };
    const update = ({ event }: PaseoAgentTimelineEvent) => {
      switch (event.type) {
        case 'replacement':
        case 'subscription_restored':
        case 'error':
          finish(this.failure(event.type === 'error' ? event.error : 'Paseo timeline was interrupted'));
          return;
        case 'timeline': {
          const { item, turnId } = event;
          if (item.type === 'user_message') {
            if (item.clientMessageId === messageId || item.messageId === messageId) {
              admitted = true;
              turn.remoteId = turnId;
              if (turnId) accept();
            }
            return;
          }
          if (!admitted || (turn.remoteId && turnId && turn.remoteId !== turnId)) return;
          if (item.type === 'assistant_message' || item.type === 'reasoning') {
            events.push({ type: item.type === 'reasoning' ? 'thought' : 'text', text: item.text });
          } else if (item.type === 'tool_call') {
            const token = secret(this.config);
            const detail = item.detail;
            const input =
              detail.type === 'unknown'
                ? detail.input
                : detail.type === 'shell'
                  ? { command: detail.command, cwd: detail.cwd }
                  : 'filePath' in detail
                    ? detail.filePath
                    : detail.type === 'search'
                      ? detail.query
                      : detail.type === 'fetch'
                        ? detail.url
                        : undefined;
            events.push({
              type: 'tool',
              requestId: item.callId,
              name: toolInputPreview(item.name, token),
              phase: item.status === 'running' ? 'start' : item.status === 'canceled' ? 'interrupted' : 'end',
              failed: item.status === 'failed',
              inputPreview: toolInputPreview(input, token),
            });
          }
          return;
        }
      }
      if (!admitted || ('turnId' in event && turn.remoteId && event.turnId && turn.remoteId !== event.turnId)) return;
      switch (event.type) {
        case 'turn_started':
          turn.remoteId ??= event.turnId;
          if (turn.remoteId) accept();
          break;
        case 'turn_completed':
        case 'turn_canceled':
        case 'turn_failed':
          finish(
            event.type === 'turn_failed' ? this.failure(event.error) : undefined,
            true,
            event.type === 'turn_canceled',
          );
          break;
        case 'permission_requested': {
          if (turn.permissions.size >= 50) {
            events.fail(new Error('Too many pending Paseo permissions'));
            break;
          }
          const request = event.request;
          const actions = new Map((request.actions ?? []).map((action) => [action.id, action.behavior]));
          turn.permissions.set(request.id, actions);
          events.push({
            type: 'approval',
            requestId: request.id,
            text: request.title ?? request.name,
            choices: [...actions.keys()],
          });
          break;
        }
        case 'permission_resolved':
          turn.permissions.delete(event.requestId);
          events.push({ type: 'approval', phase: 'end', requestId: event.requestId });
          break;
      }
    };
    let unsubscribe: ReturnType<ReturnType<PaseoApi['agents']['ref']>['timeline']['subscribe']> | undefined;
    const removeStatus = daemon.subscribeConnectionStatus((status) => {
      if (status.status === 'disconnected' || status.status === 'disposed')
        finish(new Error('Paseo connection closed'));
    });
    try {
      if (!sessionId) {
        setup.throwIfAborted();
        await raceAbort(
          daemon.createAgent({
            agentId: id,
            provider: this.config.paseoProvider,
            cwd: this.config.dshCwd,
            model: this.config.model,
            labels: { [OWNER_LABEL]: this.id },
          }),
          setup,
        );
      }
      const agent = api.agents.ref(id);
      unsubscribe = agent.timeline.subscribe(update);
      await raceAbort(unsubscribe.ready, setup);
      const snapshot = (await raceAbort(agent.refresh(), setup))?.agent;
      if (!snapshot || !this.owns(snapshot) || snapshot.archivedAt) throw new Error('Unknown Knot session on Paseo');
      if (snapshot.activeTurn || snapshot.status === 'running' || snapshot.pendingPermissions.length > 0) {
        throw new Error('The Paseo session already has an active turn');
      }
      operation.throwIfAborted();
      yield { type: 'text', sessionId: id };
      operation.throwIfAborted();
      if (turn.finished) await terminal;
      turn.submitted = true;
      try {
        await raceAbort(agent.send(text, { messageId }), operation);
      } catch (error) {
        if (!operation.aborted && !admitted) finish(this.failure(error));
        throw error;
      }
      const startDeadline = this.deadline(operation);
      try {
        await raceAbort(Promise.race([turn.started, terminal]), startDeadline);
      } catch (error) {
        if (startDeadline.aborted && !operation.aborted) {
          finish(new Error('Paseo accepted the message without starting an observable turn'));
          await terminal;
        }
        throw error;
      }
      while (true) {
        const event = await events.next(operation);
        if (event.done) break;
        yield event.value;
      }
    } catch (error) {
      if (operation.aborted) throw operation.reason;
      throw this.failure(error);
    } finally {
      const cleanup = () => {
        finish(new Error('Paseo turn observation ended'));
        this.turns.delete(id);
        removeStatus();
        unsubscribe?.();
      };
      if (!turn.finished && turn.submitted && !this.closing.signal.aborted) {
        const stopSignal = this.signal(AbortSignal.timeout(20_000));
        if (shouldSkipRemoteCancel(signal)) {
          // The job manager owns the stop. Keep listening for the original turn after local abort.
          void raceAbort(terminal, stopSignal)
            .catch(() => {})
            .finally(cleanup);
        } else {
          try {
            await this.cancel(id, stopSignal);
          } catch {
            // A standalone iterator may end without a daemon confirmation.
          } finally {
            cleanup();
          }
        }
      } else {
        cleanup();
      }
    }
  }

  isSessionBusy(id: string): boolean {
    return this.turns.has(id);
  }

  promptTerminalForCancel(id: string): Promise<void> | undefined {
    const turn = this.turns.get(id);
    return turn?.submitted ? turn.terminal : undefined;
  }

  async cancel(id: string, signal?: AbortSignal): Promise<void> {
    const turn = this.turns.get(id);
    if (!turn?.submitted) return;
    const operation = this.deadline(signal);
    await raceAbort(Promise.race([turn.started, turn.terminal]), operation);
    const { daemon, api } = await this.connect(operation);
    const snapshot = await raceAbort(api.agents.ref(id).refresh(), operation).catch((error: unknown) => {
      throw this.failure(error);
    });
    const remote = snapshot?.agent;
    operation.throwIfAborted();
    if (
      turn.finished ||
      !turn.remoteId ||
      this.turns.get(id) !== turn ||
      !remote ||
      remote.activeTurn?.turnId !== turn.remoteId ||
      !this.owns(remote)
    ) {
      await raceAbort(turn.terminal, operation);
      return;
    }
    await raceAbort(daemon.cancelAgent(id), operation).catch((error: unknown) => {
      throw this.failure(error);
    });
  }

  async respond(id: string, requestId: string, choice: string, signal?: AbortSignal): Promise<void> {
    const turn = this.turns.get(id);
    const actions = turn?.permissions.get(requestId);
    const behavior = actions?.get(choice);
    if (!turn || !actions || !behavior) throw new Error('No matching Paseo permission');
    const { daemon } = await this.connect(signal);
    const operation = this.deadline(signal);
    operation.throwIfAborted();
    if (turn.permissions.get(requestId) !== actions) throw new Error('The Paseo permission is no longer pending');
    turn.permissions.delete(requestId);
    try {
      await raceAbort(
        daemon.respondToPermissionAndWait(id, requestId, { behavior, selectedActionId: choice }),
        operation,
      );
    } catch (error) {
      if (!operation.aborted && this.turns.get(id) === turn) turn.permissions.set(requestId, actions);
      throw this.failure(error);
    }
  }

  async close(): Promise<void> {
    this.closing.abort(new Error('Paseo adapter closed'));
    const connection = this.connection;
    this.connection = undefined;
    if (connection) {
      try {
        await connection.api.dispose();
      } finally {
        await connection.daemon.close();
      }
    }
  }

  private owns(agent: { provider: string; labels: Record<string, string> }): boolean {
    return agent.provider === this.config.paseoProvider && agent.labels[OWNER_LABEL] === this.id;
  }

  private signal(signal?: AbortSignal): AbortSignal {
    return signal ? AbortSignal.any([signal, this.closing.signal]) : this.closing.signal;
  }

  private deadline(signal?: AbortSignal): AbortSignal {
    return AbortSignal.any([this.signal(signal), AbortSignal.timeout(this.config.connectTimeoutMs ?? 15_000)]);
  }

  private async connect(signal?: AbortSignal) {
    const operation = this.deadline(signal);
    operation.throwIfAborted();
    if (!this.connection) {
      if (secret(this.config)) requireSecureGateway(this.config);
      const host = urlHost(this.config.host ?? '127.0.0.1');
      const url = `${this.config.tls ? 'wss' : 'ws'}://${host}:${this.config.port ?? 6767}${this.config.basePath ?? '/ws'}`;
      const daemon = new DaemonClient({
        url,
        password: secret(this.config),
        clientId: `dsh-knot-${randomUUID()}`,
        clientType: 'cli',
        connectTimeoutMs: this.config.connectTimeoutMs ?? 15_000,
        reconnect: { enabled: false },
      });
      this.connection = { daemon, api: createPaseoApi(daemon) };
    }
    await raceAbort(this.connection.daemon.connect(), operation).catch((error: unknown) => {
      throw this.failure(error);
    });
    return this.connection;
  }

  private failure(error: unknown): Error {
    const token = secret(this.config);
    const message = error instanceof Error ? error.message : String(error);
    return new Error(redactText(token ? message.replaceAll(token, '[REDACTED]') : message).slice(0, 2_048));
  }
}
