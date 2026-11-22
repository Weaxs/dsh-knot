import { randomUUID } from 'node:crypto';
import { AcpAdapter } from './adapters/acp.js';
import { createNativeAdapter, createNativeSessionId } from './adapters/native.js';
import { LocalOnlyAbortError, raceAbort, secret } from './config.js';
import type { AgentAdapter, AgentConfig, AgentConnectionState, AgentJob, DoctorStep, PluginConfig } from './types.js';

export type AdapterFactory = (config: AgentConfig) => AgentAdapter;

const MAX_JOBS = 200;

export class AgentManager {
  readonly adapters = new Map<string, AgentAdapter>();
  readonly configs: AgentConfig[];
  private readonly factory: AdapterFactory;
  private readonly jobs = new Map<string, AgentJob>();
  private readonly jobAdapters = new Map<string, AgentAdapter>();
  private readonly completions = new Map<string, Promise<AgentJob>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly remoteCancelled = new Set<string>();
  private readonly latestSessionJob = new Map<string, string>();
  private readonly reconfiguring = new Set<string>();
  private readonly agentLocks = new Map<string, Promise<void>>();
  private readonly connectionStates = new Map<string, AgentConnectionState>();

  constructor(
    configs: AgentConfig[],
    private readonly timeoutMs = 1_800_000,
    factory: AdapterFactory = defaultFactory,
  ) {
    this.configs = [...configs];
    this.factory = factory;
    for (const config of this.configs) this.adapters.set(config.id, this.factory(config));
  }

  recordDoctorResult(agentId: string, steps: DoctorStep[]): AgentConnectionState {
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
    if (this.adapters.has(agentId)) this.connectionStates.set(agentId, state);
    return state;
  }

  list(): Array<
    Pick<
      AgentConfig,
      | 'id'
      | 'kind'
      | 'transport'
      | 'host'
      | 'ssh'
      | 'sshHost'
      | 'sshPort'
      | 'sshUser'
      | 'sshIdentityFile'
      | 'port'
      | 'tls'
      | 'basePath'
      | 'acpTransport'
      | 'acpCommand'
      | 'acpRuntimeUser'
      | 'acpLauncher'
      | 'model'
    > & {
      hasToken: boolean;
      supportsRespond: boolean;
      connection: AgentConnectionState;
    }
  > {
    return this.configs.map((config) => ({
      id: config.id,
      kind: config.kind,
      transport: config.transport,
      host: config.host,
      ssh: config.ssh,
      sshHost: config.sshHost,
      sshPort: config.sshPort,
      sshUser: config.sshUser,
      sshIdentityFile: config.sshIdentityFile,
      port: config.port,
      tls: config.tls,
      basePath: config.basePath,
      acpTransport: config.acpTransport,
      acpCommand: config.acpCommand,
      acpRuntimeUser: config.acpRuntimeUser,
      acpLauncher: config.acpLauncher,
      model: config.model,
      hasToken: Boolean(secret(config)),
      supportsRespond: typeof this.adapters.get(config.id)?.respond === 'function',
      connection: this.connectionStates.get(config.id) ?? { status: 'unverified' },
    }));
  }

  getConfig(id: string): AgentConfig | undefined {
    return this.configs.find((item) => item.id === id);
  }

  async upsert(config: AgentConfig): Promise<void> {
    return this.withAgentLock(config.id, async () => {
      this.reconfiguring.add(config.id);
      const existing = this.adapters.get(config.id);
      this.adapters.delete(config.id);
      this.connectionStates.delete(config.id);
      try {
        await this.abortJobsForAgent(config.id, existing);
        if (existing) {
          await existing.close().catch(() => {
            /* best-effort cleanup of replaced adapter */
          });
        }
        const index = this.configs.findIndex((item) => item.id === config.id);
        if (index >= 0) this.configs[index] = config;
        else this.configs.push(config);
        this.adapters.set(config.id, this.factory(config));
      } finally {
        this.reconfiguring.delete(config.id);
      }
    });
  }

  async remove(id: string): Promise<boolean> {
    return this.withAgentLock(id, async () => {
      this.reconfiguring.add(id);
      const existing = this.adapters.get(id);
      this.adapters.delete(id);
      this.connectionStates.delete(id);
      const index = this.configs.findIndex((item) => item.id === id);
      if (index >= 0) this.configs.splice(index, 1);
      try {
        await this.abortJobsForAgent(id, existing);
        if (!existing) return false;
        await existing.close().catch(() => {
          /* best-effort cleanup of removed adapter */
        });
        return true;
      } finally {
        this.reconfiguring.delete(id);
      }
    });
  }

  adapter(id: string): AgentAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter)
      throw new Error(`Unknown agent "${id}". Available: ${[...this.adapters.keys()].join(', ') || '(none)'}`);
    return adapter;
  }

  start(agentId: string, text: string, sessionId: string | undefined, onDone?: (job: AgentJob) => void): AgentJob {
    if (this.reconfiguring.has(agentId)) {
      throw new Error(`Agent "${agentId}" is currently being reconfigured or removed`);
    }
    const adapter = this.adapter(agentId);
    const config = this.configs.find((item) => item.id === agentId)!;
    const remoteSession =
      sessionId ?? (adapter.kind === 'acp' || adapter.kind === 'dsh' ? undefined : createNativeSessionId(config));
    if (adapter.kind === 'acp' && remoteSession) {
      const existingId = this.latestSessionJob.get(sessionKey(agentId, remoteSession));
      const existingJob = existingId ? this.jobs.get(existingId) : undefined;
      if (
        adapter.isSessionBusy?.(remoteSession) ||
        (existingJob &&
          (existingJob.status === 'queued' ||
            existingJob.status === 'running' ||
            this.completions.has(existingJob.id) ||
            (existingJob.status === 'cancelled' && !this.remoteCancelled.has(existingJob.id))))
      ) {
        throw new Error(
          `ACP session "${remoteSession}" still has an active or cancelling job (${existingJob?.id ?? remoteSession})`,
        );
      }
    }
    const id = randomUUID();
    const job: AgentJob = {
      id,
      agentId,
      ...(remoteSession ? { sessionId: remoteSession } : {}),
      prompt: text.slice(0, 4_000),
      status: 'queued',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      text: '',
    };
    this.jobs.set(id, job);
    this.jobAdapters.set(id, adapter);
    if (remoteSession) this.latestSessionJob.set(sessionKey(agentId, remoteSession), id);
    this.evictFinishedJobs();
    const completion = this.run(job, adapter, text, remoteSession, onDone);
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

  listJobs(): AgentJob[] {
    return [...this.jobs.values()].sort((a, b) => b.updatedAt - a.updatedAt).map((job) => ({ ...job }));
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

  async cancel(id: string, signal?: AbortSignal): Promise<AgentJob> {
    const job = this.get(id);
    if (job.status === 'completed' || job.status === 'failed') return job;
    if (job.status === 'cancelled' && this.remoteCancelled.has(id)) return job;
    const latest = job.sessionId ? this.latestSessionJob.get(sessionKey(job.agentId, job.sessionId)) : undefined;
    if (latest && latest !== id) {
      throw new Error(
        `Cannot cancel job ${id}: session "${job.sessionId}" already has a newer job on agent "${job.agentId}"`,
      );
    }
    const currentAdapter = this.adapters.get(job.agentId);
    const originalAdapter = this.jobAdapters.get(id);
    if (originalAdapter && currentAdapter !== originalAdapter) {
      throw new Error(`Cannot cancel job ${id}: agent "${job.agentId}" has been reconfigured or removed`);
    }
    job.status = 'cancelled';
    delete job.pendingApproval;
    job.updatedAt = Date.now();
    this.controllers.get(id)?.abort(new Error('job cancelled'));
    if (currentAdapter && job.sessionId) {
      await currentAdapter.cancel(job.sessionId, signal);
    }
    this.remoteCancelled.add(id);
    return job;
  }

  async respond(id: string, choice: string, signal?: AbortSignal, expectedRequestId?: string): Promise<AgentJob> {
    const job = this.get(id);
    const pending = job.pendingApproval;
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
    if (!adapter.respond) throw new Error(`${job.agentId} does not support approval responses through this adapter`);
    await adapter.respond(job.sessionId!, pending.requestId, choice, signal);
    if (job.pendingApproval?.requestId === pending.requestId) {
      delete job.pendingApproval;
    }
    job.updatedAt = Date.now();
    return job;
  }

  async close(): Promise<void> {
    for (const controller of this.controllers.values()) controller.abort(new Error('manager closed'));
    this.controllers.clear();
    await Promise.allSettled([...this.adapters.values()].map((adapter) => adapter.close()));
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

  private async abortJobsForAgent(agentId: string, adapter?: AgentAdapter): Promise<void> {
    const remoteCancels: Array<Promise<void>> = [];
    const deadlineSignal = AbortSignal.timeout(5_000);
    for (const [id, job] of this.jobs) {
      if (job.agentId !== agentId || ['completed', 'failed', 'cancelled'].includes(job.status)) continue;
      const owned = this.isLatestSessionJob(job);
      job.status = 'cancelled';
      delete job.pendingApproval;
      job.updatedAt = Date.now();
      this.controllers.get(id)?.abort(new LocalOnlyAbortError(`agent "${agentId}" reconfigured`));
      if (owned && adapter && job.sessionId) {
        remoteCancels.push(
          adapter
            .cancel(job.sessionId, deadlineSignal)
            .then(() => {
              this.remoteCancelled.add(id);
            })
            .catch(() => {
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
    const prefix = `${agentId}\0`;
    for (const key of this.latestSessionJob.keys()) {
      if (key.startsWith(prefix)) this.latestSessionJob.delete(key);
    }
  }

  private evictFinishedJobs(): void {
    if (this.jobs.size <= MAX_JOBS) return;
    for (const [id, job] of this.jobs) {
      if (this.jobs.size <= MAX_JOBS) break;
      if (['completed', 'failed', 'cancelled'].includes(job.status)) {
        this.jobs.delete(id);
        this.jobAdapters.delete(id);
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
  ): Promise<AgentJob> {
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    const timer = setTimeout(() => {
      const owned = this.isLatestSessionJob(job);
      const message = `job timed out after ${this.timeoutMs}ms`;
      controller.abort(owned ? new Error(message) : new LocalOnlyAbortError(message));
      if (owned && job.sessionId) {
        adapter
          .cancel(job.sessionId)
          .then(() => this.remoteCancelled.add(job.id))
          .catch(() => {
            /* best-effort timeout cancel; retry stays enabled because remoteCancelled is unset */
          });
      }
    }, this.timeoutMs);
    job.status = 'running';
    job.updatedAt = Date.now();
    try {
      for await (const event of adapter.prompt(sessionId, text, controller.signal)) {
        if (event.sessionId) {
          job.sessionId = event.sessionId;
          const key = sessionKey(job.agentId, event.sessionId);
          if (!this.latestSessionJob.has(key)) this.latestSessionJob.set(key, job.id);
        }
        if (event.type === 'text' && event.text) job.text = (job.text + event.text).slice(-2_000_000);
        else if (event.type === 'approval') {
          job.pendingApproval = { requestId: event.requestId ?? '', choices: event.choices ?? [], text: event.text };
        } else if (event.type === 'error') throw new Error(event.text ?? 'remote agent failed');
        else if (event.type === 'final') {
          if (event.text) job.text = event.text.slice(-2_000_000);
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
      job.updatedAt = Date.now();
      if (onDone) {
        try {
          onDone({ ...job });
        } catch {
          /* notification failures do not change the remote job */
        }
      }
    }
    return job;
  }
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
