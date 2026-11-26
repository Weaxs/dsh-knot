import { createHash, randomUUID } from 'node:crypto';
import { AcpAdapter } from './adapters/acp.js';
import { createNativeAdapter, createNativeSessionId } from './adapters/native.js';
import { LocalOnlyAbortError, normalizeToolCallId, raceAbort, secret, stripTrailingText } from './config.js';
import { type RedactionContext, retainRedactionTail } from './policy/redact.js';
import type {
  AgentAdapter,
  AgentConfig,
  AgentConnectionState,
  AgentEvent,
  AgentJob,
  AgentPromptOptions,
  AgentTimelineEntry,
  AgentToolActivity,
  DoctorStep,
  PluginConfig,
} from './types.js';

export type AdapterFactory = (config: AgentConfig) => AgentAdapter;

const MAX_JOBS = 200;
const MAX_QUEUED_PER_SESSION = 20;
const MAX_QUEUED_PROMPT_BYTES = 64 * 1024;
const CANCEL_TIMEOUT_MS = 12_000;
const MAX_JOB_TOOLS = 50;
const MAX_JOB_APPROVALS = 50;
const MAX_JOB_TEXT_LENGTH = 2_000_000;
const MAX_JOB_THOUGHT_LENGTH = 16_000;
const MAX_JOB_TIMELINE = 120;
type OutputKind = 'text' | 'thought' | 'commentary';
const outputContexts = new WeakMap<AgentJob, Partial<Record<OutputKind, RedactionContext>>>();

interface QueuedSessionJob {
  job: AgentJob;
  adapter: AgentAdapter;
  text: string;
  sessionId: string;
  onDone?: (job: AgentJob) => void;
  options?: AgentPromptOptions;
  resolve: (job: AgentJob) => void;
}

export class AgentManager {
  readonly adapters = new Map<string, AgentAdapter>();
  readonly configs: AgentConfig[];
  private readonly factory: AdapterFactory;
  private readonly jobs = new Map<string, AgentJob>();
  private readonly approvals = new WeakMap<AgentJob, Map<string, NonNullable<AgentJob['pendingApproval']>>>();
  private readonly jobOwners = new Map<
    string,
    {
      adapter: AgentAdapter;
      exclusive: boolean;
      submission?: string;
      cancelling?: Promise<void>;
      stopConfirmation?: 'pending' | 'received';
      terminalConfirmation?: Promise<void>;
      recoverStop?: (signal: AbortSignal) => Promise<void>;
    }
  >();
  private readonly configRevisions = new WeakMap<AgentConfig, string>();
  private readonly completions = new Map<string, Promise<AgentJob>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly remoteCancelled = new Set<string>();
  private readonly latestSessionJob = new Map<string, string>();
  private readonly sessionQueues = new Map<string, QueuedSessionJob[]>();
  private readonly preparingHistory = new Map<string, { ready: Promise<void>; capture: boolean }>();
  private readonly reconfiguring = new Set<string>();
  private readonly agentLocks = new Map<string, Promise<void>>();
  private readonly connectionStates = new Map<string, AgentConnectionState>();
  private jobSequence = 0;

  constructor(
    configs: AgentConfig[],
    private readonly timeoutMs = 1_800_000,
    factory: AdapterFactory = defaultFactory,
  ) {
    this.configs = [...configs];
    this.factory = factory;
    for (const config of this.configs) this.adapters.set(config.id, this.factory(config));
  }

  recordDoctorResult(config: AgentConfig, steps: DoctorStep[]): void {
    const failed = steps.find((step) => !step.ok);
    const state: AgentConnectionState = failed
      ? {
          status: 'error',
          checkedAt: Date.now(),
          failedStep: failed.name,
          error: failed.detail,
          hint: failed.hint,
          steps,
        }
      : {
          status: 'connected',
          checkedAt: Date.now(),
          steps,
        };
    if (this.getConfig(config.id) === config && !this.reconfiguring.has(config.id)) {
      this.connectionStates.set(config.id, state);
    }
  }

  list(): Array<
    Pick<
      AgentConfig,
      | 'id'
      | 'kind'
      | 'transport'
      | 'host'
      | 'port'
      | 'tls'
      | 'encryptedOverlay'
      | 'basePath'
      | 'acpTransport'
      | 'acpCommand'
      | 'model'
    > & {
      revision: string;
      hasToken: boolean;
      supportsRespond: boolean;
      supportsSessionMessages: boolean;
      connection: AgentConnectionState;
    }
  > {
    return this.configs.map((config) => ({
      id: config.id,
      kind: config.kind,
      transport: config.transport,
      host: config.host,
      port: config.port,
      tls: config.tls,
      encryptedOverlay: config.encryptedOverlay,
      basePath: config.basePath,
      acpTransport: config.acpTransport,
      acpCommand: config.acpCommand,
      model: config.model,
      revision: this.configRevision(config),
      hasToken: Boolean(secret(config)),
      supportsRespond: typeof this.adapters.get(config.id)?.respond === 'function',
      supportsSessionMessages: typeof this.adapters.get(config.id)?.getSessionMessages === 'function',
      connection: this.connectionStates.get(config.id) ?? { status: 'unverified' },
    }));
  }

  getConfig(id: string): AgentConfig | undefined {
    return this.configs.find((item) => item.id === id);
  }

  matchesRevision(id: string, revision: string): boolean {
    const config = this.getConfig(id);
    return Boolean(config && !this.reconfiguring.has(id) && this.configRevision(config) === revision);
  }

  async upsert(config: AgentConfig, persist?: () => void): Promise<void> {
    return this.withAgentLock(config.id, async () => {
      const replacement = this.factory(config);
      try {
        persist?.();
      } catch (error) {
        await replacement.close().catch(() => {
          /* best-effort cleanup of an unused adapter */
        });
        throw error;
      }
      this.reconfiguring.add(config.id);
      const existing = this.adapters.get(config.id);
      this.adapters.delete(config.id);
      this.connectionStates.delete(config.id);
      try {
        await this.abortJobsForAgent(config.id);
        if (existing) {
          await existing.close().catch(() => {
            /* best-effort cleanup of replaced adapter */
          });
        }
        const index = this.configs.findIndex((item) => item.id === config.id);
        if (index >= 0) this.configs[index] = config;
        else this.configs.push(config);
        this.configRevisions.delete(config);
        this.adapters.set(config.id, replacement);
      } finally {
        this.reconfiguring.delete(config.id);
      }
    });
  }

  async remove(id: string, persist?: () => void): Promise<boolean> {
    return this.withAgentLock(id, async () => {
      persist?.();
      this.reconfiguring.add(id);
      const existing = this.adapters.get(id);
      this.adapters.delete(id);
      this.connectionStates.delete(id);
      const index = this.configs.findIndex((item) => item.id === id);
      if (index >= 0) this.configs.splice(index, 1);
      try {
        await this.abortJobsForAgent(id);
        await existing?.close().catch(() => {
          /* best-effort cleanup of removed adapter */
        });
        return index >= 0;
      } finally {
        this.reconfiguring.delete(id);
      }
    });
  }

  adapter(id: string): AgentAdapter {
    const adapter = this.adapters.get(id);
    if (adapter) return adapter;
    throw new Error(`Unknown agent "${id}". Available: ${[...this.adapters.keys()].join(', ') || '(none)'}`);
  }

  start(
    agentId: string,
    text: string,
    sessionId: string | undefined,
    onDone?: (job: AgentJob) => void,
    exclusiveSession = false,
    clientMessageId?: string,
    queue = false,
  ): AgentJob {
    if (this.reconfiguring.has(agentId)) {
      throw new Error(`Agent "${agentId}" is currently being reconfigured or removed`);
    }
    const adapter = this.adapter(agentId);
    const id = clientMessageId ? `chat-${clientMessageId}` : randomUUID();
    const submission = clientMessageId
      ? createHash('sha256')
          .update(JSON.stringify([agentId, sessionId, text]))
          .digest('hex')
      : undefined;
    const existing = this.jobs.get(id);
    if (existing) {
      const owner = this.jobOwners.get(id);
      if (owner?.adapter === adapter && owner.submission === submission) return existing;
      throw new Error('This message submission already belongs to a different conversation or gateway');
    }
    const config = this.configs.find((item) => item.id === agentId)!;
    const remoteSession =
      sessionId ??
      (adapter.kind === 'acp' || adapter.kind === 'dsh' ? undefined : createNativeSessionId(config, clientMessageId));
    let historyOverlaps: AgentJob[] = [];
    if (remoteSession) {
      const exclusive = exclusiveSession || adapter.kind === 'acp';
      const activeSessionJobs = [...this.jobs.values()].filter((job) => {
        const owner = this.jobOwners.get(job.id);
        return (
          job.agentId === agentId &&
          job.sessionId === remoteSession &&
          owner?.adapter === adapter &&
          (job.status === 'queued' ||
            job.status === 'running' ||
            this.completions.has(job.id) ||
            owner.cancelling !== undefined ||
            (job.remoteStop !== 'unconfirmed-released' &&
              (job.remoteStop !== undefined ||
                (adapter.kind === 'acp' && job.status === 'cancelled' && !this.remoteCancelled.has(job.id)))))
        );
      });
      const existingJob = activeSessionJobs.find((job) => exclusive || this.jobOwners.get(job.id)?.exclusive);
      const hasStoppingOrUnconfirmed = activeSessionJobs.some((job) => {
        const owner = this.jobOwners.get(job.id);
        return (
          owner?.cancelling !== undefined ||
          (job.remoteStop !== 'unconfirmed-released' &&
            (job.remoteStop !== undefined ||
              (adapter.kind === 'acp' && job.status === 'cancelled' && !this.remoteCancelled.has(job.id))))
        );
      });
      if (
        existingJob &&
        queue &&
        exclusive &&
        !hasStoppingOrUnconfirmed &&
        activeSessionJobs.some((job) => !job.queued)
      ) {
        const key = sessionKey(agentId, remoteSession);
        const queuedList = this.sessionQueues.get(key) ?? [];
        if (queuedList.length >= MAX_QUEUED_PER_SESSION) {
          throw new Error(`Too many queued messages for session "${remoteSession}" (limit ${MAX_QUEUED_PER_SESSION})`);
        }
        if (Buffer.byteLength(text) > MAX_QUEUED_PROMPT_BYTES) {
          throw new Error(`Queued messages must be at most ${MAX_QUEUED_PROMPT_BYTES} bytes`);
        }
        this.evictFinishedJobs();
        if (this.jobs.size >= MAX_JOBS) {
          throw new Error(`All ${MAX_JOBS} job slots are in use. Wait for a job to finish.`);
        }
        const job: AgentJob = {
          id,
          agentId,
          sessionId: remoteSession,
          prompt: text.slice(0, 4_000),
          status: 'queued',
          queued: true,
          sequence: ++this.jobSequence,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          text: '',
        };
        this.jobs.set(id, job);
        this.jobOwners.set(id, { adapter, exclusive: true, submission });
        let resolveCompletion!: (value: AgentJob) => void;
        const completion = new Promise<AgentJob>((resolve) => {
          resolveCompletion = resolve;
        });
        this.completions.set(id, completion);
        completion
          .finally(() => {
            this.completions.delete(id);
            this.controllers.delete(id);
          })
          .catch(() => {});
        const options = clientMessageId ? { idempotencyKey: `dsh-knot:${clientMessageId}` } : undefined;
        queuedList.push({
          job,
          adapter,
          text,
          sessionId: remoteSession,
          onDone,
          options,
          resolve: resolveCompletion,
        });
        this.sessionQueues.set(key, queuedList);
        return job;
      }
      if (existingJob || (exclusive && adapter.isSessionBusy?.(remoteSession))) {
        throw new Error(
          `Session "${remoteSession}" still has an active or cancelling job (${existingJob?.id ?? remoteSession})`,
        );
      }
      if (adapter.getSessionMessages) historyOverlaps = activeSessionJobs;
    }
    this.evictFinishedJobs();
    if (this.jobs.size >= MAX_JOBS) throw new Error(`All ${MAX_JOBS} job slots are in use. Wait for a job to finish.`);
    // Concurrent turns cannot be distinguished by their position in remote history.
    for (const activeJob of historyOverlaps) {
      delete activeJob.historyBaseline;
      const preparation = this.preparingHistory.get(activeJob.id);
      if (preparation) preparation.capture = false;
    }
    const job: AgentJob = {
      id,
      agentId,
      ...(remoteSession ? { sessionId: remoteSession } : {}),
      prompt: text.slice(0, 4_000),
      status: 'queued',
      sequence: ++this.jobSequence,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      text: '',
      ...(!sessionId && adapter.getSessionMessages ? { historyBaseline: { length: 0 } } : {}),
    };
    this.jobs.set(id, job);
    this.jobOwners.set(id, { adapter, exclusive: exclusiveSession, submission });
    const lastPreparing = historyOverlaps.findLast((activeJob) => this.preparingHistory.has(activeJob.id));
    const prepareAfter = lastPreparing && this.preparingHistory.get(lastPreparing.id)?.ready;
    const captureHistory = Boolean(adapter.getSessionMessages && sessionId && historyOverlaps.length === 0);
    if (remoteSession && !captureHistory && !prepareAfter) {
      this.latestSessionJob.set(sessionKey(agentId, remoteSession), id);
    }
    const options = clientMessageId ? { idempotencyKey: `dsh-knot:${clientMessageId}` } : undefined;
    const completion = this.run(job, adapter, text, remoteSession, onDone, options, captureHistory, prepareAfter);
    this.completions.set(id, completion);
    completion
      .finally(() => {
        this.completions.delete(id);
        this.controllers.delete(id);
      })
      .catch(() => {});
    return job;
  }

  get(id: string): AgentJob {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Unknown job "${id}"`);
    return job;
  }

  getCurrentJob(agentId: string, id: string): AgentJob | undefined {
    const job = this.jobs.get(id);
    const owner = this.jobOwners.get(id);
    return job?.agentId === agentId && owner && owner.adapter === this.adapters.get(agentId) ? job : undefined;
  }

  getOutputRedactionContext(id: string, kind: OutputKind): RedactionContext | undefined {
    const job = this.jobs.get(id);
    return job && outputContexts.get(job)?.[kind];
  }

  listJobs({ currentOnly = false } = {}): AgentJob[] {
    return [...this.jobs.values()]
      .filter((job) => !currentOnly || this.jobOwners.get(job.id)?.adapter === this.adapters.get(job.agentId))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((job) => ({ ...job }));
  }

  async wait(id: string, signal?: AbortSignal): Promise<AgentJob> {
    const completion = this.completions.get(id);
    if (!completion) return this.get(id);
    if (!signal) return completion;
    if (signal.aborted) throw signal.reason ?? new Error('request aborted');
    let onAbort: (() => void) | undefined;
    try {
      return await Promise.race([
        completion,
        new Promise<never>((_, reject) => {
          onAbort = () => reject(signal.reason ?? new Error('request aborted'));
          signal.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  removeQueued(id: string, signal?: AbortSignal): AgentJob | undefined {
    signal?.throwIfAborted();
    const job = this.get(id);
    return this.cancelQueuedJob(job) ? job : undefined;
  }

  async cancel(id: string, signal?: AbortSignal): Promise<AgentJob> {
    const job = this.get(id);
    if (job.remoteStop === 'unconfirmed-released') return job;
    if (this.cancelQueuedJob(job)) return job;
    if (job.status === 'completed' || (job.status === 'failed' && !job.remoteStop)) return job;
    if (job.status === 'cancelled' && this.remoteCancelled.has(id)) return job;
    const latest = job.sessionId ? this.latestSessionJob.get(sessionKey(job.agentId, job.sessionId)) : undefined;
    if (latest && latest !== id && !this.preparingHistory.has(id)) {
      throw new Error(
        `Cannot cancel job ${id}: session "${job.sessionId}" already has a newer job on agent "${job.agentId}"`,
      );
    }
    const currentAdapter = this.adapters.get(job.agentId);
    const owner = this.jobOwners.get(id);
    if (owner && currentAdapter !== owner.adapter) {
      throw new Error(`Cannot cancel job ${id}: agent "${job.agentId}" has been reconfigured or removed`);
    }
    signal?.throwIfAborted();
    if (owner?.cancelling) {
      await raceAbort(owner.cancelling, signal);
      return job;
    }
    if (job.status === 'cancelled' && owner?.stopConfirmation === 'received') {
      delete job.remoteStop;
      this.remoteCancelled.add(id);
      job.updatedAt = Date.now();
      return job;
    }
    if (job.status !== 'failed') job.status = 'cancelled';
    delete job.pendingApproval;
    this.approvals.delete(job);
    job.updatedAt = Date.now();
    if (job.sessionId) {
      this.cancelSessionQueue(job.agentId, job.sessionId, 'Cancelled because the previous message was stopped');
    }
    const controller = this.controllers.get(id);
    const confirmation = this.captureStopConfirmation(job);
    const drain = controller && !controller.signal.aborted && confirmation ? { controller, confirmation } : undefined;
    if (!drain) {
      controller?.abort(job.sessionId ? new LocalOnlyAbortError('job cancelled') : new Error('job cancelled'));
    }
    await this.cancelRemote(job, signal, drain);
    return job;
  }

  releaseUnconfirmedStop(id: string, signal?: AbortSignal): AgentJob {
    signal?.throwIfAborted();
    const job = this.get(id);
    if (job.remoteStop === 'unconfirmed-released') return job;
    const owner = this.jobOwners.get(id);
    if (job.remoteStop !== 'unconfirmed' || !owner || !job.sessionId) {
      throw new Error('Only an unconfirmed stop can release its local session');
    }
    if (owner.adapter !== this.adapters.get(job.agentId) || !this.isLatestSessionJob(job)) {
      throw new Error('The job no longer owns this gateway session');
    }
    if (owner.cancelling || this.completions.has(id) || owner.adapter.isSessionBusy?.(job.sessionId)) {
      throw new Error('Wait for the local prompt and stop request to finish');
    }
    if (owner.stopConfirmation === 'received') {
      delete job.remoteStop;
      this.remoteCancelled.add(id);
    } else {
      job.remoteStop = 'unconfirmed-released';
    }
    job.updatedAt = Date.now();
    return job;
  }

  async respond(id: string, choice: string, signal?: AbortSignal, expectedRequestId?: string): Promise<AgentJob> {
    const job = this.get(id);
    const pending =
      job.status === 'running' && !this.controllers.get(id)?.signal.aborted ? job.pendingApproval : undefined;
    if (!pending) throw new Error(`Job ${id} has no pending approval`);
    if (expectedRequestId !== undefined && pending.requestId !== expectedRequestId) {
      throw new Error(
        `Approval request "${expectedRequestId}" is no longer pending on job ${id} (current: "${pending.requestId}")`,
      );
    }
    if (pending.choices.length > 0 && !pending.choices.includes(choice)) {
      throw new Error(
        `Invalid approval choice "${choice}" for job ${id}; expected one of: ${pending.choices.join(', ')}`,
      );
    }
    const adapter = this.adapter(job.agentId);
    if (this.jobOwners.get(id)?.adapter !== adapter) {
      throw new Error(`Cannot answer job ${id}: agent "${job.agentId}" has been reconfigured or removed`);
    }
    if (!adapter.respond) throw new Error(`${job.agentId} does not support approval responses through this adapter`);
    await adapter.respond(job.sessionId!, pending.requestId, choice, signal);
    this.removeApproval(job, pending.requestId);
    job.updatedAt = Date.now();
    return job;
  }

  async close(): Promise<void> {
    for (const key of [...this.sessionQueues.keys()]) {
      const separator = key.indexOf('\0');
      if (separator >= 0) {
        this.cancelSessionQueue(key.slice(0, separator), key.slice(separator + 1), 'manager closed');
      }
    }
    for (const controller of this.controllers.values()) controller.abort(new Error('manager closed'));
    this.controllers.clear();
    await Promise.allSettled([...this.adapters.values()].map((adapter) => adapter.close()));
  }

  private removeApproval(job: AgentJob, requestId: string): void {
    const approvals = this.approvals.get(job);
    approvals?.delete(requestId);
    if (job.pendingApproval?.requestId === requestId) {
      job.pendingApproval = approvals && [...approvals.values()].at(-1);
    }
  }

  private captureStopConfirmation(job: AgentJob): Promise<void> | undefined {
    const owner = this.jobOwners.get(job.id);
    const sessionId = job.sessionId;
    if (!owner || !sessionId || this.preparingHistory.has(job.id)) return;
    if (owner.terminalConfirmation) return owner.terminalConfirmation;
    const terminal = owner.adapter.promptTerminalForCancel?.(sessionId);
    if (!terminal) return;
    owner.stopConfirmation = 'pending';
    owner.recoverStop = owner.adapter.recoverPromptStopForCancel?.(sessionId);
    owner.terminalConfirmation = terminal.then(
      () => {
        owner.stopConfirmation = 'received';
      },
      () => {
        /* Transport failures leave confirmation pending. */
      },
    );
    return owner.terminalConfirmation;
  }

  private async cancelRemote(
    job: AgentJob,
    signal?: AbortSignal,
    drain?: { controller: AbortController; confirmation: Promise<void> },
  ): Promise<void> {
    const owner = this.jobOwners.get(job.id);
    if (owner?.cancelling) return raceAbort(owner.cancelling, signal);
    if (owner && job.sessionId && !this.preparingHistory.has(job.id)) {
      const sessionId = job.sessionId;
      const deadline = AbortSignal.timeout(CANCEL_TIMEOUT_MS);
      const stopSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
      if (owner.exclusive || owner.stopConfirmation) job.remoteStop = 'pending';
      try {
        stopSignal.throwIfAborted();
        owner.cancelling = raceAbort(
          (async () => {
            const recovering = !drain && owner.stopConfirmation === 'pending';
            const originalPromptBusy = recovering && owner.adapter.isSessionBusy?.(sessionId);
            if (recovering && !originalPromptBusy && owner.recoverStop) {
              await owner.recoverStop(stopSignal);
              owner.stopConfirmation = 'received';
            } else if (!recovering || originalPromptBusy) {
              await owner.adapter.cancel(sessionId, stopSignal);
            }
            if (drain) {
              await this.wait(job.id, stopSignal);
              await raceAbort(drain.confirmation, stopSignal);
            } else if (originalPromptBusy && owner.terminalConfirmation) {
              await raceAbort(owner.terminalConfirmation, stopSignal);
            }
            if (owner.stopConfirmation === 'pending') {
              throw new Error('The remote stop is unconfirmed because the prompt ended without a terminal response');
            }
          })(),
          stopSignal,
        );
        await owner.cancelling;
        delete job.remoteStop;
      } catch (error) {
        if (owner.exclusive || owner.stopConfirmation) job.remoteStop = 'unconfirmed';
        throw error;
      } finally {
        // Retractions can precede the remote terminal event even after the cancellation request.
        drain?.controller.abort(new LocalOnlyAbortError('job cancelled'));
        delete owner.cancelling;
        job.updatedAt = Date.now();
      }
    }
    if (this.jobs.has(job.id)) this.remoteCancelled.add(job.id);
  }

  private configRevision(config: AgentConfig): string {
    let revision = this.configRevisions.get(config);
    if (!revision) {
      revision = randomUUID();
      this.configRevisions.set(config, revision);
    }
    return revision;
  }

  private async withAgentLock<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.agentLocks.get(agentId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = prev.then(() => next);
    this.agentLocks.set(agentId, chained);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.agentLocks.get(agentId) === chained) this.agentLocks.delete(agentId);
    }
  }

  private isLatestSessionJob(job: AgentJob): boolean {
    return !job.sessionId || this.latestSessionJob.get(sessionKey(job.agentId, job.sessionId)) === job.id;
  }

  private async abortJobsForAgent(agentId: string): Promise<void> {
    const prefix = `${agentId}\0`;
    for (const key of [...this.sessionQueues.keys()]) {
      if (key.startsWith(prefix)) {
        this.cancelSessionQueue(agentId, key.slice(prefix.length), `agent "${agentId}" reconfigured`);
      }
    }
    const remoteCancels: Array<Promise<void>> = [];
    const deadlineSignal = AbortSignal.timeout(5_000);
    for (const [id, job] of this.jobs) {
      if (job.agentId !== agentId || job.status === 'completed' || job.remoteStop === 'unconfirmed-released') continue;
      const cancelling = this.jobOwners.get(id)?.cancelling;
      if ((job.status === 'cancelled' || job.status === 'failed') && !cancelling && job.remoteStop === undefined)
        continue;
      const owned = this.isLatestSessionJob(job);
      if (job.status !== 'failed') job.status = 'cancelled';
      delete job.pendingApproval;
      this.approvals.delete(job);
      job.updatedAt = Date.now();
      if (owned) this.captureStopConfirmation(job);
      this.controllers.get(id)?.abort(new LocalOnlyAbortError(`agent "${agentId}" reconfigured`));
      if (cancelling || (owned && job.sessionId)) {
        remoteCancels.push(
          this.cancelRemote(job, deadlineSignal).catch(() => {
            /* best-effort remote cancel during reconfigure; bounded by 5s deadline */
          }),
        );
      }
    }
    if (remoteCancels.length > 0) {
      await raceAbort(Promise.allSettled(remoteCancels), deadlineSignal).catch(() => {
        /* overall 5s deadline for remote cancellation during reconfigure */
      });
    }
    for (const key of this.latestSessionJob.keys()) {
      if (key.startsWith(prefix)) this.latestSessionJob.delete(key);
    }
  }

  private evictFinishedJobs(): void {
    if (this.jobs.size < MAX_JOBS) return;
    for (const [id, job] of this.jobs) {
      if (this.jobs.size < MAX_JOBS) break;
      const owner = this.jobOwners.get(id);
      if (
        !this.completions.has(id) &&
        !owner?.cancelling &&
        !(
          job.remoteStop &&
          job.remoteStop !== 'unconfirmed-released' &&
          owner?.adapter === this.adapters.get(job.agentId)
        ) &&
        ['completed', 'failed', 'cancelled'].includes(job.status)
      ) {
        this.jobs.delete(id);
        this.jobOwners.delete(id);
        this.remoteCancelled.delete(id);
        if (job.sessionId && this.latestSessionJob.get(sessionKey(job.agentId, job.sessionId)) === id) {
          this.latestSessionJob.delete(sessionKey(job.agentId, job.sessionId));
        }
      }
    }
  }

  private async run(
    job: AgentJob,
    adapter: AgentAdapter,
    text: string,
    sessionId: string | undefined,
    onDone?: (job: AgentJob) => void,
    options?: AgentPromptOptions,
    captureHistory = false,
    prepareAfter?: Promise<void>,
  ): Promise<AgentJob> {
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    let approvalOverflow = false;
    const timer = setTimeout(() => {
      if (job.status !== 'running' && job.status !== 'queued') return;
      const owned = this.isLatestSessionJob(job);
      const message = `job timed out after ${this.timeoutMs}ms`;
      if (owned) this.captureStopConfirmation(job);
      controller.abort(!owned || job.sessionId ? new LocalOnlyAbortError(message) : new Error(message));
      if (owned && job.sessionId) {
        this.cancelRemote(job).catch(() => {
          /* best-effort timeout cancel; retry stays enabled because remoteCancelled is unset */
        });
      }
    }, this.timeoutMs);
    try {
      if (captureHistory || prepareAfter) {
        let finishPreparation!: () => void;
        const preparation = {
          ready: new Promise<void>((resolve) => {
            finishPreparation = resolve;
          }),
          capture: captureHistory,
        };
        this.preparingHistory.set(job.id, preparation);
        try {
          if (prepareAfter) await raceAbort(prepareAfter, controller.signal);
          if (preparation.capture && sessionId && adapter.getSessionMessages) {
            const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(1_000)]);
            try {
              const messages = await raceAbort(adapter.getSessionMessages(sessionId, signal), signal);
              if (preparation.capture) {
                job.historyBaseline = { length: messages.length, lastId: messages.at(-1)?.id };
              }
            } catch {
              // History is best-effort and does not prevent the prompt from running.
            }
          }
        } finally {
          this.preparingHistory.delete(job.id);
          // Cancelling a waiting job must not let its successors overtake the preceding preparation.
          if (prepareAfter) void prepareAfter.then(finishPreparation);
          else finishPreparation();
        }
        controller.signal.throwIfAborted();
        if (sessionId) this.latestSessionJob.set(sessionKey(job.agentId, sessionId), job.id);
      }
      job.status = 'running';
      job.updatedAt = Date.now();
      for await (const event of adapter.prompt(sessionId, text, controller.signal, options)) {
        if (event.sessionId) {
          job.sessionId = event.sessionId;
          const key = sessionKey(job.agentId, event.sessionId);
          if (!controller.signal.aborted && !this.latestSessionJob.has(key)) {
            this.latestSessionJob.set(key, job.id);
          }
        }
        if (event.type === 'text' && event.text) {
          if (event.interim) {
            const retracted = event.retractText ?? (event.alreadyStreamed ? event.text : '');
            if (retracted) {
              reclassifyStreamedCommentary(job, event.text, retracted);
            } else {
              appendTimelineText(job, 'commentary', event.text, MAX_JOB_TEXT_LENGTH);
            }
          } else {
            setBoundedOutput(job, 'text', job.text + event.text, MAX_JOB_TEXT_LENGTH);
            appendTimelineText(job, 'text', event.text, MAX_JOB_TEXT_LENGTH);
          }
        } else if (event.type === 'thought' && event.text) {
          setBoundedOutput(job, 'thought', (job.thought ?? '') + event.text, MAX_JOB_THOUGHT_LENGTH);
          appendTimelineText(job, 'thought', event.text, MAX_JOB_THOUGHT_LENGTH);
        } else if (event.type === 'tool' && (event.phase || event.requestId)) {
          recordToolActivity(job, event);
        } else if (event.type === 'approval' && job.status === 'running') {
          const requestId = event.requestId ?? '';
          if (event.phase === 'end') this.removeApproval(job, requestId);
          else {
            const pending = { requestId, choices: event.choices ?? [], text: event.text };
            const approvals = this.approvals.get(job) ?? new Map();
            if (!approvals.delete(requestId) && approvals.size >= MAX_JOB_APPROVALS) {
              approvalOverflow = true;
              if (this.isLatestSessionJob(job)) this.captureStopConfirmation(job);
              throw new Error(`Remote agent exceeded ${MAX_JOB_APPROVALS} pending approvals`);
            }
            approvals.set(requestId, pending);
            this.approvals.set(job, approvals);
            job.pendingApproval = pending;
          }
        } else if (event.type === 'error') throw new Error(event.text ?? 'remote agent failed');
        else if (event.type === 'final') {
          if (event.text) {
            if (event.text !== job.text) {
              clearOutputContext(job, 'text');
              setBoundedOutput(job, 'text', event.text, MAX_JOB_TEXT_LENGTH);
            }
            reconcileFinalTimelineText(job, event.text);
          }
          if (job.status === 'running') {
            if (event.stopReason === 'cancelled') {
              job.status = 'cancelled';
              if (!controller.signal.aborted) this.remoteCancelled.add(job.id);
            } else {
              job.status = 'completed';
            }
          }
        }
        job.updatedAt = Date.now();
      }
      if (job.status === 'running') job.status = controller.signal.aborted ? 'cancelled' : 'completed';
    } catch (error) {
      job.status = controller.signal.aborted || job.status === 'cancelled' ? 'cancelled' : 'failed';
      job.error = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timer);
      delete job.pendingApproval;
      this.approvals.delete(job);
      if (approvalOverflow && job.status === 'failed' && job.sessionId && this.isLatestSessionJob(job)) {
        void this.cancelRemote(job).catch(() => {
          /* best-effort remote stop after approval overflow */
        });
      }
      if (job.tools?.some((tool) => tool.status === 'running' || tool.status === 'pending')) {
        job.tools = job.tools.map((tool) =>
          tool.status === 'running' || tool.status === 'pending' ? { ...tool, status: 'interrupted' } : tool,
        );
      }
      job.updatedAt = Date.now();
      this.completions.delete(job.id);
      this.controllers.delete(job.id);
      if (onDone) {
        try {
          onDone({ ...job });
        } catch {
          /* notification failures do not change the remote job */
        }
      }
    }
    this.settleSessionQueue(job);
    return job;
  }

  private cancelQueuedJob(job: AgentJob, reason?: string): boolean {
    if (!job.queued || !job.sessionId) return false;
    const key = sessionKey(job.agentId, job.sessionId);
    const queue = this.sessionQueues.get(key);
    if (!queue) return false;
    const index = queue.findIndex((entry) => entry.job.id === job.id);
    if (index < 0) return false;
    const [entry] = queue.splice(index, 1);
    if (queue.length === 0) this.sessionQueues.delete(key);
    this.finishCancelledQueuedEntry(entry!, reason);
    return true;
  }

  private cancelSessionQueue(agentId: string, sessionId: string, reason: string): void {
    const key = sessionKey(agentId, sessionId);
    const queue = this.sessionQueues.get(key);
    if (!queue?.length) return;
    this.sessionQueues.delete(key);
    for (const entry of queue) {
      this.finishCancelledQueuedEntry(entry, reason);
    }
  }

  private finishCancelledQueuedEntry(entry: QueuedSessionJob, reason?: string): void {
    delete entry.job.queued;
    entry.job.status = 'cancelled';
    if (reason) entry.job.error = reason;
    entry.job.updatedAt = Date.now();
    this.remoteCancelled.add(entry.job.id);
    this.completions.delete(entry.job.id);
    this.controllers.delete(entry.job.id);
    if (entry.onDone) {
      try {
        entry.onDone({ ...entry.job });
      } catch {
        /* notification failures do not change the remote job */
      }
    }
    entry.resolve(entry.job);
  }

  private settleSessionQueue(finishedJob: AgentJob): void {
    const sessionId = finishedJob.sessionId;
    if (!sessionId) return;
    const key = sessionKey(finishedJob.agentId, sessionId);
    const queue = this.sessionQueues.get(key);
    if (!queue?.length) return;
    const owner = this.jobOwners.get(finishedJob.id);
    const adapter = this.adapters.get(finishedJob.agentId);
    if (!owner || owner.adapter !== adapter || this.reconfiguring.has(finishedJob.agentId)) return;
    if (finishedJob.status !== 'completed' || finishedJob.remoteStop !== undefined || owner.cancelling) {
      const reason =
        finishedJob.status === 'failed'
          ? 'Cancelled because the previous message failed'
          : 'Cancelled because the previous message was stopped';
      this.cancelSessionQueue(finishedJob.agentId, sessionId, reason);
      return;
    }
    const otherExecuting = [...this.jobs.values()].some((candidate) => {
      if (candidate.id === finishedJob.id || candidate.queued) return false;
      if (candidate.agentId !== finishedJob.agentId || candidate.sessionId !== sessionId) return false;
      const candidateOwner = this.jobOwners.get(candidate.id);
      if (candidateOwner?.adapter !== adapter) return false;
      return (
        candidate.status === 'queued' ||
        candidate.status === 'running' ||
        this.completions.has(candidate.id) ||
        candidateOwner.cancelling !== undefined ||
        (candidate.remoteStop !== undefined && candidate.remoteStop !== 'unconfirmed-released')
      );
    });
    if (otherExecuting) return;
    if (adapter.isSessionBusy?.(sessionId)) {
      this.cancelSessionQueue(finishedJob.agentId, sessionId, 'Cancelled because the session is still busy');
      return;
    }
    const next = queue.shift();
    if (queue.length === 0) this.sessionQueues.delete(key);
    if (!next) return;
    delete next.job.queued;
    next.job.updatedAt = Date.now();
    const captureHistory = Boolean(next.adapter.getSessionMessages);
    if (!captureHistory) {
      this.latestSessionJob.set(key, next.job.id);
    }
    void this.run(next.job, next.adapter, next.text, next.sessionId, next.onDone, next.options, captureHistory).then(
      next.resolve,
    );
  }
}

function recordToolActivity(job: AgentJob, event: AgentEvent): void {
  const tools = job.tools ?? [];
  const name = event.name?.trim().slice(0, 120);
  const callId = event.requestId ? normalizeToolCallId(event.requestId) : undefined;
  const index = callId
    ? tools.findIndex((tool) => tool.id === callId)
    : event.phase === 'end'
      ? tools.findIndex((tool) => tool.status === 'running' && tool.name === (name || 'tool'))
      : -1;
  const previous = tools[index];
  const inputPreview = event.inputPreview ?? previous?.inputPreview;
  const title = event.title?.trim().slice(0, 120) || previous?.title;
  let status = previous?.status ?? 'pending';
  if (event.phase === 'end') status = event.failed ? 'failed' : 'completed';
  else if (event.phase === 'start' && status === 'pending') status = 'running';
  const activity: AgentToolActivity = {
    id: previous?.id ?? callId ?? randomUUID(),
    name: name || previous?.name || 'tool',
    status,
    ...(title ? { title } : {}),
    ...(inputPreview ? { inputPreview } : {}),
  };
  job.tools = previous
    ? tools.map((tool, i) => (i === index ? activity : tool))
    : [...tools.slice(-(MAX_JOB_TOOLS - 1)), activity];
  if (!previous) {
    appendTimelineTool(job, activity.id);
    if (tools.length >= MAX_JOB_TOOLS && job.timeline) {
      const liveIds = new Set(job.tools.map((tool) => tool.id));
      job.timeline = job.timeline.filter((entry) => entry.kind !== 'tool' || liveIds.has(entry.toolId));
    }
  }
}

function setBoundedOutput(job: AgentJob, kind: 'text' | 'thought', text: string, maxLength: number): void {
  const dropped = text.length - maxLength;
  if (dropped > 0) rememberOutputContext(job, kind, text.slice(0, dropped));
  job[kind] = dropped > 0 ? text.slice(dropped) : text;
}

function appendTimelineText(job: AgentJob, kind: OutputKind, chunk: string, maxLength: number): void {
  const timeline = job.timeline ?? [];
  const last = timeline.at(-1);
  if (last && last.kind === kind) {
    last.text += chunk;
  } else {
    limitTimeline(job, [...timeline, { kind, text: chunk }]);
  }
  trimTimelineBudget(job, kind === 'thought' ? 'thought' : 'text', maxLength);
}

function rememberOutputContext(job: AgentJob, kind: OutputKind, dropped: string): void {
  const contexts = outputContexts.get(job) ?? {};
  contexts[kind] = retainRedactionTail(contexts[kind], dropped);
  outputContexts.set(job, contexts);
}

function clearOutputContext(job: AgentJob, kind: OutputKind): void {
  const contexts = outputContexts.get(job);
  if (contexts) delete contexts[kind];
}

function limitTimeline(job: AgentJob, timeline: AgentTimelineEntry[]): void {
  for (const entry of timeline.slice(0, -MAX_JOB_TIMELINE)) {
    if (entry.kind === 'commentary') rememberOutputContext(job, 'commentary', entry.text);
  }
  job.timeline = timeline.slice(-MAX_JOB_TIMELINE);
}

function trimTimelineBudget(job: AgentJob, bucket: 'text' | 'thought', maxChars: number): void {
  const timeline = job.timeline;
  if (!timeline?.length) return;
  const matches = (entry: AgentTimelineEntry): entry is { kind: 'text' | 'commentary' | 'thought'; text: string } =>
    bucket === 'thought' ? entry.kind === 'thought' : entry.kind === 'text' || entry.kind === 'commentary';
  let total = 0;
  for (const entry of timeline) {
    if (matches(entry)) total += entry.text.length;
  }
  if (total <= maxChars) return;
  let excess = total - maxChars;
  const trimmed: AgentTimelineEntry[] = [];
  for (const entry of timeline) {
    if (!matches(entry) || excess <= 0) {
      trimmed.push(entry);
      continue;
    }
    if (entry.kind === 'commentary') rememberOutputContext(job, 'commentary', entry.text.slice(0, excess));
    if (entry.text.length <= excess) {
      excess -= entry.text.length;
      continue;
    }
    trimmed.push({ ...entry, text: entry.text.slice(excess) });
    excess = 0;
  }
  job.timeline = trimmed;
}

function appendTimelineTool(job: AgentJob, toolId: string): void {
  const timeline = job.timeline ?? [];
  if (timeline.some((entry) => entry.kind === 'tool' && entry.toolId === toolId)) return;
  limitTimeline(job, [...timeline, { kind: 'tool', toolId }]);
}

function reclassifyStreamedCommentary(job: AgentJob, commentary: string, retracted: string): void {
  const previous = job.text;
  const retainedRetraction =
    previous.length === MAX_JOB_TEXT_LENGTH ? retracted.slice(-MAX_JOB_TEXT_LENGTH) : retracted;
  job.text = stripTrailingText(previous, retainedRetraction);
  if (!job.text) clearOutputContext(job, 'text');

  const timeline = job.timeline ?? [];
  const retainedReplyLength = timeline.reduce(
    (length, entry) => length + (entry.kind === 'text' ? entry.text.length : 0),
    0,
  );
  let charsToRemove = Math.min(previous.length - job.text.length, retainedReplyLength);
  if (!charsToRemove) {
    appendTimelineText(job, 'commentary', commentary, MAX_JOB_TEXT_LENGTH);
    return;
  }

  const next = [...timeline];
  const commentaryEntry = { kind: 'commentary' as const, text: commentary };
  for (let i = timeline.length - 1; i >= 0; i--) {
    const entry = timeline[i];
    if (entry?.kind !== 'text') continue;
    charsToRemove -= entry.text.length;
    if (charsToRemove > 0) {
      next.splice(i, 1);
      continue;
    }
    const prefix = entry.text.slice(0, -charsToRemove);
    const replacement = prefix ? [{ ...entry, text: prefix }, commentaryEntry] : [commentaryEntry];
    next.splice(i, 1, ...replacement);
    break;
  }
  limitTimeline(job, next);
  trimTimelineBudget(job, 'text', MAX_JOB_TEXT_LENGTH);
}

function reconcileFinalTimelineText(job: AgentJob, finalText: string): void {
  const bounded = finalText.slice(-MAX_JOB_TEXT_LENGTH);
  const timeline = job.timeline ?? [];
  const textEntries = timeline.filter((entry): entry is { kind: 'text'; text: string } => entry.kind === 'text');
  if (textEntries.length === 0) {
    appendTimelineText(job, 'text', bounded, MAX_JOB_TEXT_LENGTH);
    return;
  }
  const combined = textEntries.map((entry) => entry.text).join('');
  if (combined === bounded) {
    return;
  }
  if (bounded.startsWith(combined)) {
    appendTimelineText(job, 'text', bounded.slice(combined.length), MAX_JOB_TEXT_LENGTH);
    return;
  }
  // Divergent authoritative final replaces stale streamed text while preserving thoughts, tools, and commentary.
  job.timeline = timeline.filter((entry) => entry.kind !== 'text');
  appendTimelineText(job, 'text', bounded, MAX_JOB_TEXT_LENGTH);
}

function sessionKey(agentId: string, sessionId: string): string {
  return `${agentId}\0${sessionId}`;
}

function defaultFactory(config: AgentConfig): AgentAdapter {
  return config.kind === 'acp' ? new AcpAdapter(config.id, config) : createNativeAdapter(config);
}

export function fromConfig(config: PluginConfig): AgentManager {
  return new AgentManager(config.agents ?? [], config.jobTimeoutMs);
}
