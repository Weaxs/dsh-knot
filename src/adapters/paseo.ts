import { randomUUID } from 'node:crypto';
import { createPaseoApi, type PaseoAgentTimelineEvent, type PaseoApi } from '@getpaseo/client';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { AsyncQueue } from '../async-queue.js';
import { raceAbort, secret, shouldSkipRemoteCancel, urlHost } from '../config.js';
import { requireSecureGateway } from '../policy/auth.js';
import { redactText, toolInputPreview } from '../policy/redact.js';
import type { AgentAdapter, AgentApprovalQuestion, AgentConfig, AgentEvent, AgentSession } from '../types.js';

const OWNER_LABEL = 'dsh-knot';
const MAX_TRACKED_TURNS = 32;

interface Permission {
  actions: Map<string, 'allow' | 'deny'>;
  questions: Array<AgentApprovalQuestion & { header: string }>;
  defaultActions: boolean;
  responding?: boolean;
}

function readQuestions(input: unknown): Permission['questions'] {
  if (!input || typeof input !== 'object' || !('questions' in input) || !Array.isArray(input.questions)) return [];
  return input.questions.slice(0, 20).flatMap((item: unknown) => {
    if (!item || typeof item !== 'object' || !('question' in item) || typeof item.question !== 'string') return [];
    return [
      {
        header: 'header' in item && typeof item.header === 'string' ? item.header : item.question,
        text: item.question,
        options:
          'options' in item && Array.isArray(item.options)
            ? item.options
                .slice(0, 30)
                .flatMap((option: unknown) =>
                  option && typeof option === 'object' && 'label' in option && typeof option.label === 'string'
                    ? [option.label]
                    : [],
                )
            : [],
        multiSelect: 'multiSelect' in item && item.multiSelect === true,
        allowEmpty: 'allowEmpty' in item && item.allowEmpty === true,
      },
    ];
  });
}

interface Turn {
  events: AsyncQueue<AgentEvent>;
  terminal: Promise<void>;
  started: Promise<void>;
  submitted: boolean;
  finished: boolean;
  confirmed?: boolean;
  remoteId?: string;
  permissions: Map<string, Permission>;
}

export class PaseoAdapter implements AgentAdapter {
  readonly kind = 'paseo' as const;
  private readonly closing = new AbortController();
  private readonly turns = new Map<string, Turn>();
  private readonly recoverableTurns = new Map<string, string>();
  private connection?: { daemon: DaemonClient; api: PaseoApi };

  constructor(
    readonly id: string,
    private readonly config: AgentConfig,
  ) {}

  async listProviders(signal?: AbortSignal, cwd?: string) {
    const { api } = await this.connect(signal);
    const result = await raceAbort(api.providers.snapshot({ cwd }), this.deadline(signal)).catch((error: unknown) => {
      throw this.failure(error);
    });
    return result.entries
      .filter((entry) => entry.enabled && entry.status === 'ready')
      .map((entry) => ({ id: entry.provider, label: entry.label ?? entry.provider }));
  }

  async health(signal?: AbortSignal): Promise<Record<string, unknown>> {
    const providers = await this.listProviders(signal, this.config.dshCwd);
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
    if (this.hasUnconfirmedTurn(id)) throw new Error('Recover or release the previous Paseo turn first');
    if (this.turns.size + this.recoverableTurns.size >= MAX_TRACKED_TURNS) {
      throw new Error('Too many active or unconfirmed Paseo turns');
    }
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
      turn.confirmed = confirmed;
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
          const questions = request.kind === 'question' ? readQuestions(request.input) : [];
          const defaultActions = !actions.size;
          if (defaultActions && !questions.length) {
            if (request.kind !== 'question') actions.set('approve', 'allow');
            actions.set('deny', 'deny');
          }
          turn.permissions.set(request.id, { actions, questions, defaultActions });
          events.push({
            type: 'approval',
            requestId: request.id,
            text: request.title ?? request.name,
            choices: questions.length ? [] : [...actions.keys()],
            questions: questions.length
              ? questions.map(({ text, options, multiSelect, allowEmpty }) => ({
                  text,
                  options,
                  multiSelect,
                  allowEmpty,
                }))
              : undefined,
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
        if (!turn.confirmed && turn.remoteId && !this.closing.signal.aborted) {
          this.recoverableTurns.set(id, turn.remoteId);
        }
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
    if (!turn?.submitted) {
      if (this.hasUnconfirmedTurn(id)) await this.recoverStop(id, signal);
      return;
    }
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

  hasUnconfirmedTurn(id: string): boolean {
    return this.recoverableTurns.has(id);
  }

  releaseUnconfirmedTurn(id: string): void {
    this.recoverableTurns.delete(id);
  }

  private async recoverStop(id: string, signal?: AbortSignal): Promise<void> {
    const turnId = this.recoverableTurns.get(id);
    if (!turnId) throw new Error('The original Paseo turn is no longer tracked');
    const operation = this.deadline(signal);
    try {
      const { daemon, api } = await this.connect(operation);
      const agent = api.agents.ref(id);
      const getAgent = async () => {
        const snapshot = (await raceAbort(agent.refresh(), operation))?.agent;
        if (!snapshot || !this.owns(snapshot) || (snapshot.status === 'running' && !snapshot.activeTurn)) {
          throw new Error('Cannot verify the original Paseo session');
        }
        operation.throwIfAborted();
        return snapshot;
      };
      const before = await getAgent();
      if (this.recoverableTurns.get(id) !== turnId || this.turns.has(id)) {
        throw new Error('The original Paseo turn is no longer tracked');
      }
      if (before.activeTurn?.turnId === turnId) {
        await raceAbort(daemon.cancelAgent(id), operation);
        const after = await getAgent();
        if (after.activeTurn?.turnId === turnId) throw new Error('The original Paseo turn is still running');
      }
      this.recoverableTurns.delete(id);
    } catch (error) {
      throw this.failure(error);
    }
  }

  async respond(id: string, requestId: string, choice: string, signal?: AbortSignal): Promise<void> {
    const turn = this.turns.get(id);
    const permission = turn?.permissions.get(requestId);
    if (!turn || !permission) throw new Error('No matching Paseo permission');
    type Response = Parameters<DaemonClient['respondToPermissionAndWait']>[2];
    let response: Response;
    const behavior = permission.actions.get(choice);
    if (permission.questions.length && choice !== 'deny') {
      let answers: unknown;
      try {
        answers = JSON.parse(choice);
      } catch {
        throw new Error('Provide a JSON array of answers in question order');
      }
      const questions = permission.questions;
      if (
        !Array.isArray(answers) ||
        answers.length !== questions.length ||
        !answers.every(
          (answer, index) =>
            typeof answer === 'string' && answer.length <= 4_000 && (answer.trim() || questions[index]?.allowEmpty),
        )
      ) {
        throw new Error('Provide one answer for each Paseo question');
      }
      response = {
        behavior: 'allow',
        updatedInput: {
          answers: Object.fromEntries(questions.map((question, index) => [question.header, answers[index]])),
        },
      };
    } else if (permission.questions.length && choice === 'deny') {
      response = { behavior: 'deny' };
    } else {
      if (!behavior) throw new Error('No matching Paseo permission choice');
      response = permission.defaultActions ? { behavior } : { behavior, selectedActionId: choice };
    }
    const { daemon } = await this.connect(signal);
    const operation = this.deadline(signal);
    operation.throwIfAborted();
    if (turn.permissions.get(requestId) !== permission) throw new Error('The Paseo permission is no longer pending');
    if (permission.responding) throw new Error('A response to this Paseo permission is already in progress');
    permission.responding = true;
    const submission = daemon
      .respondToPermissionAndWait(id, requestId, response, this.config.connectTimeoutMs ?? 15_000)
      .then(() => {
        if (turn.permissions.get(requestId) === permission) {
          turn.permissions.delete(requestId);
          turn.events.push({ type: 'approval', phase: 'end', requestId });
        }
      })
      .finally(() => {
        permission.responding = false;
      });
    await raceAbort(submission, operation).catch((error: unknown) => {
      throw this.failure(error);
    });
  }

  async close(): Promise<void> {
    this.closing.abort(new Error('Paseo adapter closed'));
    this.recoverableTurns.clear();
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
