import { describe, expect, it, vi } from 'vitest';
import { runDoctor } from '../src/doctor.js';
import { AgentManager } from '../src/manager.js';
import type { AgentAdapter, AgentConfig, AgentEvent, AgentJob } from '../src/types.js';

class FakeAdapter implements AgentAdapter {
  cancelled = false;
  constructor(
    readonly id: string,
    readonly kind: AgentAdapter['kind'] = 'dsh',
  ) {}
  async health() {
    return { ok: true };
  }
  async listSessions() {
    return [];
  }
  async *prompt(session: string | undefined, _text?: string, _signal?: AbortSignal): AsyncIterable<AgentEvent> {
    void session;
    yield { type: 'text', text: 'part ' };
    yield { type: 'approval', requestId: 'r1', choices: ['once', 'deny'], text: 'Run bash?' };
    yield { type: 'final', text: 'part done' };
  }
  async cancel() {
    this.cancelled = true;
  }
  async respond(_session: string, _request: string, choice: string) {
    expect(choice).toBe('once');
  }
  async close() {}
}

const config: AgentConfig = { id: 'remote', kind: 'dsh', transport: 'local' };

class RunningAdapter extends FakeAdapter {
  override async *prompt(
    _session: string | undefined,
    _text?: string,
    signal?: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    yield { type: 'text', text: 'partial reply' };
    signal?.throwIfAborted();
    await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
  }
}

describe('AgentManager', () => {
  it('does not apply a doctor result from an agent replaced during the check', async () => {
    let completeProbe!: (result: { ok: boolean }) => void;
    const probe = new Promise<{ ok: boolean }>((resolve) => {
      completeProbe = resolve;
    });
    class SlowHealthAdapter extends FakeAdapter {
      override health() {
        return probe;
      }
    }
    const manager = new AgentManager([config], 10_000, (current) =>
      current === config ? new SlowHealthAdapter(current.id) : new FakeAdapter(current.id),
    );
    const checking = runDoctor(manager, config.id);
    await manager.upsert({ ...config, port: 443 });
    completeProbe({ ok: true });
    await checking;
    expect(manager.list()[0]?.connection.status).toBe('unverified');
    await manager.close();
  });

  it('keeps the last doctor result when the caller aborts a new check', async () => {
    const adapter = new FakeAdapter(config.id);
    const manager = new AgentManager([config], 10_000, () => adapter);
    await runDoctor(manager, config.id);
    const previous = manager.list()[0]?.connection;
    expect(previous?.status).toBe('connected');

    const controller = new AbortController();
    const reason = new Error('Doctor request aborted');
    vi.spyOn(adapter, 'health').mockImplementationOnce(async () => {
      controller.abort(reason);
      throw reason;
    });
    await expect(runDoctor(manager, config.id, controller.signal)).rejects.toBe(reason);
    expect(manager.list()[0]?.connection).toBe(previous);
    await manager.close();
  });

  it('bounds job admission while all slots are active and evicts finished jobs', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    class BusyAdapter extends FakeAdapter {
      override async *prompt(): AsyncIterable<AgentEvent> {
        await blocked;
        yield { type: 'final', text: 'done' };
      }
    }
    const manager = new AgentManager([config], 10_000, () => new BusyAdapter(config.id));
    const jobs = Array.from({ length: 200 }, () => manager.start(config.id, 'work', undefined));
    expect(() => manager.start(config.id, 'overflow', undefined)).toThrow(/job slots are in use/);
    release();
    await Promise.all(jobs.map((job) => manager.wait(job.id)));
    await manager.wait(manager.start(config.id, 'next job', undefined).id);
    expect(manager.listJobs()).toHaveLength(200);
    expect(() => manager.get(jobs[0]!.id)).toThrow(/Unknown job/);
    await manager.close();
  });

  it.each(['manual', 'timeout'])('keeps an exclusive session locked during %s remote cancellation', async (mode) => {
    let acknowledge!: () => void;
    let cancellations = 0;
    let closed = false;
    const pending = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    class PendingCancelAdapter extends FakeAdapter {
      override async *prompt(
        _sessionId: string | undefined,
        _text: string,
        signal?: AbortSignal,
      ): AsyncIterable<AgentEvent> {
        if (signal?.aborted) return;
        await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
      }

      override cancel(): Promise<void> {
        cancellations++;
        return pending;
      }

      override async close() {
        closed = true;
      }
    }
    const manager = new AgentManager(
      [config],
      mode === 'manual' ? 10_000 : 20,
      () => new PendingCancelAdapter(config.id),
    );
    const job = manager.start(config.id, 'panel turn', 'shared', undefined, true);
    const cancelling = mode === 'manual' ? manager.cancel(job.id) : undefined;
    await manager.wait(job.id);
    const retry = manager.cancel(job.id);
    expect(() => manager.start(config.id, 'tool turn', 'shared')).toThrow(/active or cancelling job/);
    expect(manager.getCurrentJob(config.id, job.id)?.remoteStop).toBe('pending');
    expect(cancellations).toBe(1);
    const replacing = manager.upsert({ ...config, port: 443 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      expect(closed).toBe(false);
    } finally {
      acknowledge();
      await Promise.all([cancelling, retry, replacing]);
    }
    expect(closed).toBe(true);
    await manager.close();
  });

  it('leaves a running job alone when the Stop request was already aborted', async () => {
    const adapter = new RunningAdapter(config.id);
    const cancel = vi.spyOn(adapter, 'cancel');
    const manager = new AgentManager([config], 10_000, () => adapter);
    const job = manager.start(config.id, 'Hello', 'shared', undefined, true);
    const reason = new Error('stop request disconnected');
    await expect(manager.cancel(job.id, AbortSignal.abort(reason))).rejects.toBe(reason);
    expect(job.status).toBe('running');
    expect(job.remoteStop).toBeUndefined();
    expect(cancel).not.toHaveBeenCalled();
    expect(() => manager.start(config.id, 'Next turn', 'shared', undefined, true)).toThrow(/active or cancelling job/);
    await manager.cancel(job.id);
    expect(cancel).toHaveBeenCalledOnce();
    await manager.wait(job.id);
    await manager.close();
  });

  it('keeps a disconnected ACP stop unconfirmed until explicitly releasing the local session', async () => {
    let disconnect!: () => void;
    let rejectTerminal!: (error: Error) => void;
    const terminal = new Promise<unknown>((_, reject) => {
      rejectTerminal = reject;
    });
    class DisconnectedAdapter extends FakeAdapter {
      promptTerminalForCancel(): Promise<unknown> | undefined {
        return this.cancelled ? undefined : terminal;
      }

      override async *prompt(_sessionId: string | undefined, text?: string): AsyncIterable<AgentEvent> {
        if (text !== 'Hello') {
          yield { type: 'final', text: 'next reply' };
          return;
        }
        yield { type: 'text', text: 'partial reply' };
        await new Promise<void>((resolve) => {
          disconnect = resolve;
        });
        yield { type: 'error', text: 'ACP connection closed' };
      }

      override async cancel() {
        this.cancelled = true;
        disconnect();
        rejectTerminal(new Error('ACP connection closed'));
      }
    }

    const adapter = new DisconnectedAdapter(config.id, 'paseo');
    const cancel = vi.spyOn(adapter, 'cancel');
    const manager = new AgentManager([{ ...config, kind: 'paseo' }], 10_000, () => adapter);
    try {
      const job = manager.start(config.id, 'Hello', 'shared');
      await vi.waitFor(() => expect(disconnect).toBeTypeOf('function'));
      const stopping = manager.cancel(job.id);
      expect(() => manager.releaseUnconfirmedStop(job.id)).toThrow(/Only an unconfirmed stop/);
      await expect(stopping).rejects.toThrow(/terminal response/);
      expect(await manager.wait(job.id)).toMatchObject({
        status: 'cancelled',
        text: 'partial reply',
        error: 'ACP connection closed',
        remoteStop: 'unconfirmed',
      });
      await expect(manager.cancel(job.id)).rejects.toThrow(/terminal response/);
      expect(cancel).toHaveBeenCalledOnce();
      expect(job.remoteStop).toBe('unconfirmed');
      expect(() => manager.start(config.id, 'next prompt', 'shared')).toThrow(/active or cancelling/);
      expect(manager.releaseUnconfirmedStop(job.id).remoteStop).toBe('unconfirmed-released');
      const next = manager.start(config.id, 'next prompt', 'shared');
      await manager.cancel(job.id);
      expect(cancel).toHaveBeenCalledOnce();
      expect((await manager.wait(next.id)).text).toBe('next reply');
      await Promise.all(
        Array.from({ length: 198 }, () => manager.wait(manager.start(config.id, 'other prompt', undefined).id)),
      );
      await manager.wait(manager.start(config.id, 'fill a reclaimed slot', undefined).id);
      expect(() => manager.get(job.id)).toThrow(/unknown job/i);
    } finally {
      await manager.close();
    }
  });

  it.each(['dsh', 'paseo'] as const)(
    'keeps an exclusive %s session locked until a remote stop retry succeeds',
    async (kind) => {
      const adapter = new RunningAdapter(config.id, kind);
      vi.spyOn(adapter, 'cancel').mockRejectedValueOnce(new Error('remote stop failed'));
      const manager = new AgentManager([{ ...config, kind }], 10_000, () => adapter);
      const job = manager.start(config.id, 'Hello', 'shared', undefined, true);
      await vi.waitFor(() => expect(job.text).toBe('partial reply'));
      await expect(manager.cancel(job.id)).rejects.toThrow('remote stop failed');
      await manager.wait(job.id);
      expect(manager.getCurrentJob(config.id, job.id)?.remoteStop).toBe('unconfirmed');
      expect(() => manager.start(config.id, 'Next turn', 'shared', undefined, true)).toThrow(
        /active or cancelling job/,
      );
      expect(await manager.cancel(job.id)).toMatchObject({ status: 'cancelled', text: 'partial reply' });
      expect(manager.getCurrentJob(config.id, job.id)?.remoteStop).toBeUndefined();
      await manager.close();
    },
  );

  it('retains a timed-out job when a synchronous Stop failure leaves the session locked', async () => {
    class TimedApprovalAdapter extends RunningAdapter {
      override async *prompt(
        sessionId: string | undefined,
        text: string,
        signal?: AbortSignal,
      ): AsyncIterable<AgentEvent> {
        yield { type: 'approval', requestId: 'waiting', choices: ['once'] };
        yield* super.prompt(sessionId, text, signal);
      }
    }
    const adapter = new TimedApprovalAdapter(config.id);
    const cancel = vi.spyOn(adapter, 'cancel').mockImplementationOnce(() => {
      throw new Error('cannot stop the run');
    });
    const respond = vi.spyOn(adapter, 'respond');
    const other = { ...config, id: 'other' };
    const manager = new AgentManager([config, other], 20, (entry) =>
      entry === config ? adapter : new FakeAdapter(entry.id),
    );
    const job = manager.start(config.id, 'Timeout', 'shared', undefined, true);
    await manager.wait(job.id);
    await vi.waitFor(() => expect(job.remoteStop).toBe('unconfirmed'));
    expect(job.status).toBe('cancelled');
    expect(job.pendingApproval).toBeUndefined();
    await expect(manager.respond(job.id, 'once', undefined, 'waiting')).rejects.toThrow(/no pending approval/);
    expect(respond).not.toHaveBeenCalled();

    for (let index = 0; index < 200; index++) {
      await manager.wait(manager.start(other.id, 'Short turn', undefined).id);
    }
    expect(manager.listJobs()).toHaveLength(200);
    expect(manager.getCurrentJob(config.id, job.id)).toBe(job);
    expect(() => manager.start(config.id, 'Next turn', 'shared', undefined, true)).toThrow(/active or cancelling job/);
    await manager.cancel(job.id);
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(job.remoteStop).toBeUndefined();
    await manager.wait(manager.start(other.id, 'Free a confirmed job slot', undefined).id);
    expect(manager.getCurrentJob(config.id, job.id)).toBeUndefined();
    await manager.close();
  });

  it('assigns consecutive job order when creation timestamps tie', async () => {
    const manager = new AgentManager([config], 10_000, () => new FakeAdapter(config.id));
    const now = vi.spyOn(Date, 'now').mockReturnValue(10_000);
    try {
      const first = manager.start(config.id, 'first', 'session');
      await manager.wait(first.id);
      const second = manager.start(config.id, 'second', 'session');
      await manager.wait(second.id);
      expect(first.createdAt).toBe(second.createdAt);
      expect([first.sequence, second.sequence]).toEqual([1, 2]);
    } finally {
      now.mockRestore();
      await manager.close();
    }
  });

  it('tracks jobs, approvals and completion notifications', async () => {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    class ApprovalAdapter extends FakeAdapter {
      override async *prompt(): AsyncIterable<AgentEvent> {
        yield { type: 'text', text: 'part ', sessionId: 'remote-assigned-id' };
        yield { type: 'approval', requestId: 'r1', choices: ['once', 'deny'], text: 'Run bash?' };
        await finished;
        yield { type: 'final', text: 'part done' };
      }
    }
    const adapter = new ApprovalAdapter(config.id);
    const manager = new AgentManager([config], 10_000, () => adapter);
    let notified = false;
    const job = manager.start('remote', 'work', undefined, () => {
      notified = true;
    });
    try {
      await vi.waitFor(() => expect(job.pendingApproval?.requestId).toBe('r1'));
      expect(job.sessionId).toBe('remote-assigned-id');
      await expect(manager.respond(job.id, 'once', undefined, 'wrong-request')).rejects.toThrow(/no longer pending/);
      await expect(manager.respond(job.id, 'bogus-choice', undefined, 'r1')).rejects.toThrow(/Invalid approval choice/);
      await manager.respond(job.id, 'once', undefined, 'r1');
      expect(job.pendingApproval).toBeUndefined();
    } finally {
      finish();
    }
    const completed = await manager.wait(job.id);
    expect(completed.status).toBe('completed');
    expect(completed.text).toBe('part done');
    expect(notified).toBe(true);
    await manager.close();
  });

  it('keeps bounded thoughts and tool activity separate from the reply', async () => {
    let finish!: () => void;
    const finishTurn = new Promise<void>((resolve) => {
      finish = resolve;
    });
    class ToolAdapter extends FakeAdapter {
      override async *prompt(): AsyncIterable<AgentEvent> {
        yield { type: 'thought', text: `${'x'.repeat(16_000)}Check the ` };
        yield { type: 'thought', text: 'README first.' };
        yield {
          type: 'tool',
          requestId: 'a',
          phase: 'start',
          name: 'read_file',
          text: 'private tool arguments',
          inputPreview: 'README.md',
        };
        yield { type: 'tool', requestId: 'b', phase: 'pending', name: 'read_file' };
        yield { type: 'tool', requestId: 'b', inputPreview: 'MISSING.md' };
        yield { type: 'tool', requestId: 'c', phase: 'start', name: 'terminal' };
        await finishTurn;
        yield { type: 'tool', requestId: 'b', phase: 'start' };
        yield { type: 'tool', requestId: 'b', phase: 'end', failed: true };
        yield { type: 'tool', requestId: 'b', phase: 'start', inputPreview: 'MISSING.md' };
        yield { type: 'tool', requestId: 'a', phase: 'end' };
        yield { type: 'final', text: 'Done' };
      }
    }
    const manager = new AgentManager([config], 10_000, () => new ToolAdapter(config.id));
    const job = manager.start(config.id, 'run', undefined);
    try {
      await vi.waitFor(() => expect(manager.getCurrentJob(config.id, job.id)?.tools).toHaveLength(3));
      expect(job.tools?.map(({ status }) => status)).toEqual(['running', 'pending', 'running']);
      expect(job.tools?.[1]?.inputPreview).toBe('MISSING.md');
      expect(job.thought).toHaveLength(16_000);
      expect(job.thought?.endsWith('Check the README first.')).toBe(true);
      expect(job.text).toBe('');
    } finally {
      finish();
    }
    const completed = await manager.wait(job.id);
    expect(completed.tools?.map(({ name, status }) => [name, status])).toEqual([
      ['read_file', 'completed'],
      ['read_file', 'failed'],
      ['terminal', 'interrupted'],
    ]);
    expect(completed.tools?.[0]?.inputPreview).toBe('README.md');
    expect(completed.tools?.[1]?.inputPreview).toBe('MISSING.md');
    expect(JSON.stringify(completed.tools)).not.toContain('private tool arguments');
    expect(completed.text).toBe('Done');
    await manager.close();
  });

  it('retries remote cancellation after a gateway failure', async () => {
    let cancelAttempts = 0;
    class FlakyCancelAdapter extends FakeAdapter {
      override async *prompt(
        session: string | undefined,
        _text: string,
        signal?: AbortSignal,
      ): AsyncIterable<AgentEvent> {
        yield { type: 'text', text: '', sessionId: session ?? 'live-session-1' };
        await new Promise<void>((resolve) => {
          if (signal?.aborted) resolve();
          else signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      }
      override async cancel() {
        cancelAttempts++;
        if (cancelAttempts === 1) throw new Error('temporary gateway error');
        this.cancelled = true;
      }
    }
    const adapter = new FlakyCancelAdapter('remote');
    const manager = new AgentManager([config], 10_000, () => adapter);
    const job = manager.start('remote', 'work', undefined);
    await new Promise((r) => setTimeout(r, 10));
    await expect(manager.cancel(job.id)).rejects.toThrow(/temporary gateway error/);
    expect(cancelAttempts).toBe(1);
    const retried = await manager.cancel(job.id);
    expect(retried.status).toBe('cancelled');
    expect(cancelAttempts).toBe(2);
    expect(adapter.cancelled).toBe(true);

    // Once a newer job starts on the same session, retrying cancel on a superseded job is rejected
    cancelAttempts = 0;
    adapter.cancelled = false;
    const oldJob = manager.start('remote', 'turn 1', 'shared-session');
    await new Promise((r) => setTimeout(r, 10));
    await expect(manager.cancel(oldJob.id)).rejects.toThrow(/temporary gateway error/);
    const newerJob = manager.start('remote', 'turn 2', 'shared-session');
    await new Promise((r) => setTimeout(r, 10));
    await expect(manager.cancel(oldJob.id)).rejects.toThrow(/newer job/);
    expect(cancelAttempts).toBe(1);
    expect(manager.get(newerJob.id).status).toBe('running');
    await manager.cancel(newerJob.id);
    expect(cancelAttempts).toBe(2);
  });

  it('clears only the handled pendingApproval when a newer approval arrives mid-respond', async () => {
    let releaseRespond!: () => void;
    class SlowRespondAdapter extends FakeAdapter {
      override async *prompt(): AsyncIterable<AgentEvent> {
        yield { type: 'approval', requestId: 'r1', choices: ['once', 'deny'], text: 'First?' };
        await new Promise((r) => setTimeout(r, 15));
        yield { type: 'approval', requestId: 'r2', choices: ['once', 'deny'], text: 'Second?' };
        await new Promise((r) => setTimeout(r, 30));
        yield { type: 'final', text: 'done' };
      }
      override async respond() {
        await new Promise<void>((resolve) => {
          releaseRespond = resolve;
        });
      }
    }
    const manager = new AgentManager([config], 10_000, () => new SlowRespondAdapter('remote'));
    const job = manager.start('remote', 'work', 'sess-a');
    await new Promise((r) => setTimeout(r, 5));
    const responding = manager.respond(job.id, 'once', undefined, 'r1');
    await new Promise((r) => setTimeout(r, 20));
    expect(manager.get(job.id).pendingApproval?.requestId).toBe('r2');
    releaseRespond();
    await responding;
    expect(manager.get(job.id).pendingApproval?.requestId).toBe('r2');
    await manager.wait(job.id);
  });

  it('keeps simultaneous approvals reachable one at a time', async () => {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    class ParallelApprovalAdapter extends FakeAdapter {
      override async *prompt(): AsyncIterable<AgentEvent> {
        yield { type: 'approval', requestId: 'first', choices: ['once'] };
        yield { type: 'approval', requestId: 'second', choices: ['once'] };
        await finished;
        yield { type: 'final', text: 'done' };
      }
    }
    const manager = new AgentManager([config], 10_000, () => new ParallelApprovalAdapter(config.id));
    const job = manager.start(config.id, 'work', 'session');
    try {
      await vi.waitFor(() => expect(job.pendingApproval?.requestId).toBe('second'));
      await manager.respond(job.id, 'once', undefined, 'second');
      expect(job.pendingApproval?.requestId).toBe('first');
      await manager.respond(job.id, 'once', undefined, 'first');
      expect(job.pendingApproval).toBeUndefined();
    } finally {
      finish();
      await manager.wait(job.id);
      await manager.close();
    }
  });

  it('reveals the next approval after the gateway resolves the current one', async () => {
    let resolveApproval!: () => void;
    const resolved = new Promise<void>((resolve) => {
      resolveApproval = resolve;
    });
    class ExternalApprovalAdapter extends RunningAdapter {
      override async *prompt(
        sessionId: string | undefined,
        text: string,
        signal?: AbortSignal,
      ): AsyncIterable<AgentEvent> {
        yield { type: 'approval', requestId: 'first', choices: ['once'] };
        yield { type: 'approval', requestId: 'second', choices: ['once'] };
        await resolved;
        yield { type: 'approval', requestId: 'second', phase: 'end' };
        yield* super.prompt(sessionId, text, signal);
      }
    }
    const adapter = new ExternalApprovalAdapter(config.id);
    const respond = vi.spyOn(adapter, 'respond');
    const manager = new AgentManager([config], 10_000, () => adapter);
    const job = manager.start(config.id, 'work', 'session');
    try {
      await vi.waitFor(() => expect(job.pendingApproval?.requestId).toBe('second'));
      resolveApproval();
      await vi.waitFor(() => expect(job.pendingApproval?.requestId).toBe('first'));
      await expect(manager.respond(job.id, 'once', undefined, 'second')).rejects.toThrow(/no longer pending/);
      expect(respond).not.toHaveBeenCalled();
      await manager.respond(job.id, 'once', undefined, 'first');
      expect(job.pendingApproval).toBeUndefined();
    } finally {
      resolveApproval();
      await manager.cancel(job.id);
      await manager.wait(job.id);
      await manager.close();
    }
  });

  it('fails the job and retries an unconfirmed remote stop after approval overflow', async () => {
    class ManyApprovalsAdapter extends FakeAdapter {
      override async *prompt(): AsyncIterable<AgentEvent> {
        yield { type: 'text', text: 'partial reply' };
        for (let index = 0; index < 51; index++) {
          yield { type: 'approval', requestId: String(index), choices: ['once'] };
        }
      }
    }
    const adapter = new ManyApprovalsAdapter(config.id);
    const cancel = vi.spyOn(adapter, 'cancel').mockRejectedValueOnce(new Error('cannot stop the run'));
    const manager = new AgentManager([config], 10_000, () => adapter);
    try {
      const job = manager.start(config.id, 'work', 'session', undefined, true);
      await manager.wait(job.id);
      expect(job).toMatchObject({ status: 'failed', text: 'partial reply', error: /exceeded 50 pending approvals/ });
      expect(job.pendingApproval).toBeUndefined();
      await vi.waitFor(() => expect(job.remoteStop).toBe('unconfirmed'));
      expect(() => manager.start(config.id, 'next turn', 'session')).toThrow(/active or cancelling job/);
      await manager.cancel(job.id);
      expect(cancel).toHaveBeenCalledTimes(2);
      expect(job.status).toBe('failed');
      expect(job.remoteStop).toBeUndefined();
    } finally {
      await manager.close();
    }
  });

  it('does not remotely cancel a newer job on the same session when an older job times out', async () => {
    let remoteCancels = 0;
    class HangingSessionAdapter extends FakeAdapter {
      override async *prompt(
        _session: string | undefined,
        _text: string,
        signal?: AbortSignal,
      ): AsyncIterable<AgentEvent> {
        await new Promise<void>((resolve) => {
          if (signal?.aborted) resolve();
          else signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      }
      override async cancel() {
        remoteCancels++;
      }
    }
    const manager = new AgentManager([config], 40, () => new HangingSessionAdapter('remote'));
    const oldJob = manager.start('remote', 'turn 1', 'timeout-session');
    const newJob = manager.start('remote', 'turn 2', 'timeout-session');
    await new Promise((r) => setTimeout(r, 60));
    expect(manager.get(oldJob.id).status).toBe('cancelled');
    // Only the latest job's own timeout may call adapter.cancel (at most 1, never from oldJob)
    expect(remoteCancels).toBeLessThanOrEqual(1);
    await manager.wait(newJob.id);
  });

  it('cancels active work, aborts local stream and rejects unknown agents', async () => {
    let aborted = false;
    class HangingAdapter extends FakeAdapter {
      override async *prompt(
        _session: string | undefined,
        _text: string,
        signal?: AbortSignal,
      ): AsyncIterable<AgentEvent> {
        yield { type: 'text', text: 'partial' };
        await new Promise<void>((resolve) => {
          if (signal?.aborted) {
            aborted = true;
            resolve();
            return;
          }
          signal?.addEventListener('abort', () => {
            aborted = true;
            resolve();
          });
        });
      }
    }
    const adapter = new HangingAdapter('remote');
    const manager = new AgentManager([config], 10_000, () => adapter);
    const job = manager.start('remote', 'work', 'session-1');
    expect((await manager.cancel(job.id)).status).toBe('cancelled');
    const settled = await manager.wait(job.id);
    expect(settled.status).toBe('cancelled');
    expect(aborted).toBe(true);
    expect(adapter.cancelled).toBe(true);
    expect(() => manager.start('missing', 'x', undefined)).toThrow(/Unknown agent/);
  });

  it('rejects an overlapping ACP job before overwriting session ownership so the active job remains cancellable', async () => {
    let cancelledSession: string | undefined;
    const acpConfig: AgentConfig = { id: 'acp-remote', kind: 'paseo', transport: 'local' };
    class HangingPaseoAdapter implements AgentAdapter {
      readonly kind = 'paseo' as const;
      constructor(readonly id: string) {}
      async health() {
        return { ok: true };
      }
      async listSessions() {
        return [];
      }
      async *prompt(session: string | undefined, _text: string, signal?: AbortSignal): AsyncIterable<AgentEvent> {
        const sid = session ?? 'acp-sess-1';
        yield { type: 'text', text: '', sessionId: sid };
        await new Promise<void>((resolve) => {
          if (signal?.aborted) resolve();
          else signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      }
      async cancel(session: string) {
        cancelledSession = session;
      }
      async close() {}
    }
    const manager = new AgentManager([acpConfig], 10_000, () => new HangingPaseoAdapter('acp-remote'));
    const first = manager.start('acp-remote', 'turn 1', undefined);
    await new Promise((r) => setTimeout(r, 10));
    expect(first.sessionId).toBe('acp-sess-1');
    expect(() => manager.start('acp-remote', 'turn 2', 'acp-sess-1')).toThrow(/active or cancelling job/);
    const cancelled = await manager.cancel(first.id);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelledSession).toBe('acp-sess-1');
    await manager.wait(first.id);
  });

  it('rejects a second ACP turn while cancellation is in-flight or failed, allowing cancel retry before starting turn 2', async () => {
    let cancelAttempts = 0;
    let releaseFirstCancel!: () => void;
    let releaseStreamCleanup!: () => void;
    const acpConfig: AgentConfig = { id: 'acp-flaky', kind: 'paseo', transport: 'local' };
    class FlakyPaseoAdapter implements AgentAdapter {
      readonly kind = 'paseo' as const;
      constructor(readonly id: string) {}
      async health() {
        return { ok: true };
      }
      async listSessions() {
        return [];
      }
      async *prompt(session: string | undefined, text: string, signal?: AbortSignal): AsyncIterable<AgentEvent> {
        const sid = session ?? 'acp-sess-2';
        yield { type: 'text', text: '', sessionId: sid };
        if (text === 'turn 1') {
          await new Promise<void>((resolve) => {
            if (signal?.aborted) resolve();
            else signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          await new Promise<void>((resolve) => {
            releaseStreamCleanup = resolve;
          });
          return;
        }
        yield { type: 'final', text: 'turn-2-ok', sessionId: sid };
      }
      async cancel() {
        cancelAttempts++;
        if (cancelAttempts === 1) {
          await new Promise<void>((resolve) => {
            releaseFirstCancel = resolve;
          });
          throw new Error('gateway timeout on cancel');
        }
      }
      async close() {}
    }
    const manager = new AgentManager([acpConfig], 10_000, () => new FlakyPaseoAdapter('acp-flaky'));
    const first = manager.start('acp-flaky', 'turn 1', undefined);
    await new Promise((r) => setTimeout(r, 10));

    // Start cancelling turn 1 — while remote cancel is in-flight, turn 2 must be rejected
    const firstCancelPromise = manager.cancel(first.id);
    await new Promise((r) => setTimeout(r, 10));
    expect(() => manager.start('acp-flaky', 'turn 2', 'acp-sess-2')).toThrow(/active or cancelling job/);

    // First remote cancel fails — turn 2 must STILL be rejected and retry of cancel must succeed
    releaseFirstCancel();
    await expect(firstCancelPromise).rejects.toThrow(/gateway timeout on cancel/);
    expect(() => manager.start('acp-flaky', 'turn 2', 'acp-sess-2')).toThrow(/active or cancelling job/);

    await manager.cancel(first.id);
    expect(cancelAttempts).toBe(2);

    // While local stream cleanup hasn't finished yet, turn 2 is still rejected
    expect(() => manager.start('acp-flaky', 'turn 2', 'acp-sess-2')).toThrow(/active or cancelling job/);

    // Once stream cleanup finishes and remote cancel succeeded, turn 2 is admitted
    releaseStreamCleanup();
    await manager.wait(first.id);
    await new Promise((r) => setTimeout(r, 5));
    const second = manager.start('acp-flaky', 'turn 2', 'acp-sess-2');
    const done = await manager.wait(second.id);
    expect(done.status).toBe('completed');
    expect(done.text).toBe('turn-2-ok');
  });

  it('preserves cancel retry after failed timeout cancel and releases session locks when ACP agent config is replaced', async () => {
    let cancelCalls = 0;
    const acpConfig: AgentConfig = { id: 'acp-reconfig', kind: 'paseo', transport: 'local' };
    class TimeoutCancelAdapter implements AgentAdapter {
      readonly kind = 'paseo' as const;
      constructor(readonly id: string) {}
      async health() {
        return { ok: true };
      }
      async listSessions() {
        return [];
      }
      async *prompt(session: string | undefined, text: string, signal?: AbortSignal): AsyncIterable<AgentEvent> {
        const sid = session ?? 'acp-reconfig-sess';
        yield { type: 'text', text: '', sessionId: sid };
        if (text === 'slow') {
          await new Promise<void>((resolve) => {
            if (signal?.aborted) resolve();
            else signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          yield { type: 'final', text: '', stopReason: 'cancelled', sessionId: sid };
          return;
        }
        yield { type: 'final', text: 'after-upsert', sessionId: sid };
      }
      async cancel() {
        cancelCalls++;
        if (cancelCalls === 1) throw new Error('timeout cancel failed');
      }
      async close() {}
    }
    const manager = new AgentManager([acpConfig], 30, () => new TimeoutCancelAdapter('acp-reconfig'));
    const job = manager.start('acp-reconfig', 'slow', undefined);
    await manager.wait(job.id);
    // Timeout's adapter.cancel failed on attempt 1, so locally synthesized final/cancelled must NOT block retry
    expect(cancelCalls).toBe(1);
    await manager.cancel(job.id);
    expect(cancelCalls).toBe(2);

    // Replacing the ACP agent config via upsert attempts remote cancel on the old adapter before closing it
    const job2 = manager.start('acp-reconfig', 'slow', 'acp-reconfig-sess');
    await new Promise((r) => setTimeout(r, 5));
    const beforeUpsertCancels = cancelCalls;
    await manager.upsert({ ...acpConfig, model: 'updated-model' });
    expect(cancelCalls).toBe(beforeUpsertCancels + 1);
    await manager.wait(job2.id);
    const job3 = manager.start('acp-reconfig', 'fast', 'acp-reconfig-sess');
    const settled = await manager.wait(job3.id);
    expect(settled.status).toBe('completed');
    expect(settled.text).toBe('after-upsert');

    // If remote cancel fails during upsert, manual retry of cancel(job) still invokes gateway cancel
    let failingCancelAttempts = 0;
    const dshCfg: AgentConfig = { id: 'dsh-reconfig', kind: 'dsh', transport: 'local' };
    class FailingUpsertCancelAdapter implements AgentAdapter {
      readonly kind = 'dsh' as const;
      constructor(readonly id: string) {}
      async health() {
        return { ok: true };
      }
      async listSessions() {
        return [];
      }
      async *prompt(session: string | undefined, _text: string, signal?: AbortSignal): AsyncIterable<AgentEvent> {
        yield { type: 'text', text: '', sessionId: session ?? 'dsh-sess-1' };
        await new Promise<void>((resolve) => {
          if (signal?.aborted) resolve();
          else signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      }
      async cancel() {
        failingCancelAttempts++;
        if (failingCancelAttempts === 1) throw new Error('gateway unreachable during upsert');
      }
      async close() {}
    }
    // After upsert replaces the adapter, retrying cancel on the old job refuses to target the new gateway
    const dshManager = new AgentManager([dshCfg], 10_000, () => new FailingUpsertCancelAdapter('dsh-reconfig'));
    const dshJob = dshManager.start('dsh-reconfig', 'work', undefined);
    await new Promise((r) => setTimeout(r, 10));
    await dshManager.upsert({ ...dshCfg, model: 'm2' });
    expect(failingCancelAttempts).toBe(1);
    await expect(dshManager.cancel(dshJob.id)).rejects.toThrow(/reconfigured or removed/);
    expect(failingCancelAttempts).toBe(1);

    // After remove() fails remote cancel, retrying cancel(job) also rejects instead of falsely returning cancelled
    let failOnRemoveAttempts = 0;
    const rmFailCfg: AgentConfig = { id: 'rm-fail', kind: 'dsh', transport: 'local' };
    class RemoveFailAdapter extends FailingUpsertCancelAdapter {
      override async cancel() {
        failOnRemoveAttempts++;
        throw new Error('gateway unreachable on remove');
      }
    }
    const rmFailManager = new AgentManager([rmFailCfg], 10_000, () => new RemoveFailAdapter('rm-fail'));
    const rmFailJob = rmFailManager.start('rm-fail', 'work', undefined);
    await new Promise((r) => setTimeout(r, 10));
    await rmFailManager.remove('rm-fail');
    expect(failOnRemoveAttempts).toBe(1);
    await expect(rmFailManager.cancel(rmFailJob.id)).rejects.toThrow(/reconfigured or removed/);
    await rmFailManager.wait(rmFailJob.id);

    // While remove() is awaiting remote cancel, new jobs on that agent are immediately rejected
    let releaseRemoveCancel!: () => void;
    const blockingCfg: AgentConfig = { id: 'blocking', kind: 'dsh', transport: 'local' };
    class BlockingCancelAdapter extends FailingUpsertCancelAdapter {
      override async cancel() {
        await new Promise<void>((resolve) => {
          releaseRemoveCancel = resolve;
        });
      }
    }
    const rmManager = new AgentManager([blockingCfg], 10_000, () => new BlockingCancelAdapter('blocking'));
    const rmJob = rmManager.start('blocking', 'work', undefined);
    await new Promise((r) => setTimeout(r, 10));
    const removing = rmManager.remove('blocking');
    await new Promise((r) => setTimeout(r, 10));
    expect(() => rmManager.start('blocking', 'sneaky', undefined)).toThrow(/reconfigured or removed/);
    releaseRemoveCancel();
    await removing;
    await rmManager.wait(rmJob.id);
    await dshManager.close();
  });

  it('preserves chronological timeline interleaving across thoughts, tools, and text', async () => {
    class InterleavedAdapter extends FakeAdapter {
      override async *prompt(): AsyncIterable<AgentEvent> {
        yield { type: 'thought', text: 'Step 1 ' };
        yield { type: 'thought', text: 'plan.' };
        yield { type: 'text', text: 'Checking ' };
        yield { type: 'text', text: 'repo...' };
        yield { type: 'tool', requestId: 't1', phase: 'start', name: 'terminal', inputPreview: 'git status' };
        yield { type: 'tool', requestId: 't1', phase: 'end' };
        yield { type: 'thought', text: 'Step 2 plan.' };
        yield { type: 'tool', requestId: 't2', phase: 'start', name: 'memory' };
        yield { type: 'tool', requestId: 't2', phase: 'end' };
        yield { type: 'text', text: 'All done.' };
        yield { type: 'final', text: 'Checking repo...All done.' };
      }
    }
    const manager = new AgentManager([config], 10_000, () => new InterleavedAdapter(config.id));
    const job = manager.start(config.id, 'sync', undefined);
    const done = await manager.wait(job.id);
    expect(done.tools).toHaveLength(2);
    expect(done.timeline).toEqual([
      { kind: 'thought', text: 'Step 1 plan.' },
      { kind: 'text', text: 'Checking repo...' },
      { kind: 'tool', toolId: done.tools![0]!.id },
      { kind: 'thought', text: 'Step 2 plan.' },
      { kind: 'tool', toolId: done.tools![1]!.id },
      { kind: 'text', text: 'All done.' },
    ]);
    await manager.close();

    // Non-streamed final reply still lands after earlier tools in the timeline
    class FinalAfterToolAdapter extends FakeAdapter {
      override async *prompt(): AsyncIterable<AgentEvent> {
        yield { type: 'tool', requestId: 't1', phase: 'start', name: 'terminal' };
        yield { type: 'tool', requestId: 't1', phase: 'end' };
        yield { type: 'final', text: 'Final summary' };
      }
    }
    const finalManager = new AgentManager([config], 10_000, () => new FinalAfterToolAdapter(config.id));
    const finalDone = await finalManager.wait(finalManager.start(config.id, 'run', undefined).id);
    expect(finalDone.timeline).toEqual([
      { kind: 'tool', toolId: finalDone.tools![0]!.id },
      { kind: 'text', text: 'Final summary' },
    ]);
    await finalManager.close();
  });

  it('retracts the retained reply when streamed commentary exceeds the text budget', async () => {
    const tail = 'x'.repeat(2_000_000);
    const commentary = `Checking ${tail}`;
    class OversizedInterimAdapter extends FakeAdapter {
      override async *prompt(): AsyncIterable<AgentEvent> {
        yield { type: 'text', text: `Checking ${tail.slice(0, 200)}` };
        for (let i = 0; i < 120; i++) {
          yield { type: 'tool', requestId: `t${i}`, phase: 'start', name: 'terminal' };
        }
        yield { type: 'text', text: tail.slice(200) };
        yield { type: 'text', text: commentary, interim: true, alreadyStreamed: true };
        yield { type: 'final', text: '', stopReason: 'cancelled' };
      }
    }
    const manager = new AgentManager([config], 10_000, () => new OversizedInterimAdapter(config.id));
    try {
      const job = await manager.wait(manager.start(config.id, 'check', undefined).id);
      expect(job.text).toHaveLength(0);
      expect(job.timeline?.filter((entry) => entry.kind !== 'tool')).toEqual([{ kind: 'commentary', text: tail }]);
    } finally {
      await manager.close();
    }
  });

  it('reconciles aggregate and divergent finals, keeps interim commentary out of job.text, and bounds timeline budgets', async () => {
    // 1. Aggregate final after tool appends only the missing suffix (text('A') -> tool -> final('AB'))
    class AggregateFinalAdapter extends FakeAdapter {
      override async *prompt(): AsyncIterable<AgentEvent> {
        yield { type: 'text', text: 'A' };
        yield { type: 'tool', requestId: 't1', phase: 'start', name: 'terminal' };
        yield { type: 'tool', requestId: 't1', phase: 'end' };
        yield { type: 'final', text: 'AB' };
      }
    }
    const aggManager = new AgentManager([config], 10_000, () => new AggregateFinalAdapter(config.id));
    const aggDone = await aggManager.wait(aggManager.start(config.id, 'agg', undefined).id);
    expect(aggDone.text).toBe('AB');
    expect(aggDone.timeline).toEqual([
      { kind: 'text', text: 'A' },
      { kind: 'tool', toolId: aggDone.tools![0]!.id },
      { kind: 'text', text: 'B' },
    ]);
    await aggManager.close();

    // 2. Divergent authoritative final drops stale draft text while keeping thought, commentary, and tools
    class DivergentFinalAdapter extends FakeAdapter {
      override async *prompt(): AsyncIterable<AgentEvent> {
        yield { type: 'thought', text: 'Plan check' };
        yield { type: 'text', text: 'Checking repo...', interim: true };
        yield { type: 'text', text: 'stale draft' };
        yield { type: 'tool', requestId: 't1', phase: 'start', name: 'terminal' };
        yield { type: 'tool', requestId: 't1', phase: 'end' };
        yield { type: 'final', text: 'Authoritative reply' };
      }
    }
    const divManager = new AgentManager([config], 10_000, () => new DivergentFinalAdapter(config.id));
    const divDone = await divManager.wait(divManager.start(config.id, 'div', undefined).id);
    expect(divDone.text).toBe('Authoritative reply');
    expect(divDone.timeline).toEqual([
      { kind: 'thought', text: 'Plan check' },
      { kind: 'commentary', text: 'Checking repo...' },
      { kind: 'tool', toolId: divDone.tools![0]!.id },
      { kind: 'text', text: 'Authoritative reply' },
    ]);
    await divManager.close();

    // 2b. Final matching only the last segment prefix still drops stale earlier draft text
    class PartialPrefixDivergentAdapter extends FakeAdapter {
      override async *prompt(): AsyncIterable<AgentEvent> {
        yield { type: 'text', text: 'Draft A' };
        yield { type: 'tool', requestId: 't1', phase: 'start', name: 'terminal' };
        yield { type: 'tool', requestId: 't1', phase: 'end' };
        yield { type: 'text', text: 'Starting B' };
        yield { type: 'final', text: 'Starting B with corrections' };
      }
    }
    const prefixManager = new AgentManager([config], 10_000, () => new PartialPrefixDivergentAdapter(config.id));
    const prefixDone = await prefixManager.wait(prefixManager.start(config.id, 'fix', undefined).id);
    expect(prefixDone.text).toBe('Starting B with corrections');
    expect(prefixDone.timeline).toEqual([
      { kind: 'tool', toolId: prefixDone.tools![0]!.id },
      { kind: 'text', text: 'Starting B with corrections' },
    ]);
    await prefixManager.close();

    // 2c. Retraction can span text blocks split by a thought event.
    class AlreadyStreamedInterimAdapter extends FakeAdapter {
      override async *prompt(): AsyncIterable<AgentEvent> {
        yield { type: 'text', text: 'Keep this. Checking ' };
        yield { type: 'thought', text: 'Inspect the repository.' };
        yield { type: 'text', text: 'repo...' };
        yield { type: 'text', text: 'Checking repo...', interim: true, alreadyStreamed: true };
        yield { type: 'final', text: '', stopReason: 'cancelled' };
      }
    }
    const streamedInterimManager = new AgentManager(
      [config],
      10_000,
      () => new AlreadyStreamedInterimAdapter(config.id),
    );
    const streamedInterimDone = await streamedInterimManager.wait(
      streamedInterimManager.start(config.id, 'check', undefined).id,
    );
    expect(streamedInterimDone.status).toBe('cancelled');
    expect(streamedInterimDone.text).toBe('Keep this. ');
    expect(streamedInterimDone.timeline).toEqual([
      { kind: 'text', text: 'Keep this. ' },
      { kind: 'commentary', text: 'Checking repo...' },
      { kind: 'thought', text: 'Inspect the repository.' },
    ]);
    await streamedInterimManager.close();

    // 3. Interim commentary stays in UI timeline without polluting model-facing job.text
    class InterimAdapter extends FakeAdapter {
      override async *prompt(): AsyncIterable<AgentEvent> {
        yield { type: 'text', text: 'Working on it...', interim: true };
        yield { type: 'tool', requestId: 't1', phase: 'start', name: 'terminal' };
        yield { type: 'tool', requestId: 't1', phase: 'end' };
        yield { type: 'text', text: 'All clean.' };
        yield { type: 'final', text: 'All clean.' };
      }
    }
    const interimManager = new AgentManager([config], 10_000, () => new InterimAdapter(config.id));
    const interimDone = await interimManager.wait(interimManager.start(config.id, 'check', undefined).id);
    expect(interimDone.text).toBe('All clean.');
    expect(interimDone.timeline).toEqual([
      { kind: 'commentary', text: 'Working on it...' },
      { kind: 'tool', toolId: interimDone.tools![0]!.id },
      { kind: 'text', text: 'All clean.' },
    ]);
    await interimManager.close();

    // 4. Aggregate per-job text and thought budgets cap total timeline size across alternating segments
    class HugeTimelineAdapter extends FakeAdapter {
      override async *prompt(): AsyncIterable<AgentEvent> {
        for (let i = 0; i < 30; i++) {
          yield { type: 'text', text: String(i % 10).repeat(200_000) };
          yield { type: 'thought', text: String((i + 1) % 10).repeat(1_000) };
        }
        yield { type: 'final', text: '' };
      }
    }
    const hugeManager = new AgentManager([config], 10_000, () => new HugeTimelineAdapter(config.id));
    const hugeDone = await hugeManager.wait(hugeManager.start(config.id, 'huge', undefined).id);
    const totalTextChars = (hugeDone.timeline ?? [])
      .filter(
        (entry): entry is { kind: 'text' | 'commentary'; text: string } =>
          entry.kind === 'text' || entry.kind === 'commentary',
      )
      .reduce((sum, entry) => sum + entry.text.length, 0);
    const totalThoughtChars = (hugeDone.timeline ?? [])
      .filter((entry): entry is { kind: 'thought'; text: string } => entry.kind === 'thought')
      .reduce((sum, entry) => sum + entry.text.length, 0);
    expect(hugeDone.text.length).toBe(2_000_000);
    expect(totalTextChars).toBe(2_000_000);
    expect(hugeDone.thought?.length).toBe(16_000);
    expect(totalThoughtChars).toBe(16_000);
    await hugeManager.close();
  });

  it('allows releasing an unconfirmed stop locally for native Hermes exclusive sessions', async () => {
    class NativeStopFailureAdapter extends RunningAdapter {
      override async *prompt(
        _sessionId: string | undefined,
        text?: string,
        signal?: AbortSignal,
      ): AsyncIterable<AgentEvent> {
        if (text === 'next prompt') {
          yield { type: 'final', text: 'recovered reply' };
          return;
        }
        yield* super.prompt(_sessionId, text, signal);
      }
    }
    const adapter = new NativeStopFailureAdapter(config.id, 'dsh');
    vi.spyOn(adapter, 'cancel').mockRejectedValueOnce(new Error('Hermes remote stop is unconfirmed: timeout'));
    const manager = new AgentManager([config], 10_000, () => adapter);
    try {
      const job = manager.start(config.id, 'stuck turn', 'shared', undefined, true);
      await vi.waitFor(() => expect(job.text).toBe('partial reply'));
      await expect(manager.cancel(job.id)).rejects.toThrow(/unconfirmed/);
      await manager.wait(job.id);
      expect(job.remoteStop).toBe('unconfirmed');
      expect(() => manager.start(config.id, 'next prompt', 'shared', undefined, true)).toThrow(
        /active or cancelling job/,
      );
      expect(manager.releaseUnconfirmedStop(job.id).remoteStop).toBe('unconfirmed-released');
      const next = manager.start(config.id, 'next prompt', 'shared', undefined, true);
      expect((await manager.wait(next.id)).text).toBe('recovered reply');
    } finally {
      await manager.close();
    }
  });

  it('queues follow-up messages per session in FIFO order and allows removing queued items', async () => {
    const prompts: string[] = [];
    const resolvers = new Map<string, () => void>();
    class GateAdapter extends FakeAdapter {
      override async *prompt(_sessionId: string | undefined, text?: string): AsyncIterable<AgentEvent> {
        const msg = text ?? '';
        prompts.push(msg);
        await new Promise<void>((resolve) => {
          resolvers.set(msg, resolve);
        });
        yield { type: 'final', text: `reply:${msg}` };
      }
    }
    const adapter = new GateAdapter(config.id);
    const cancelSpy = vi.spyOn(adapter, 'cancel');
    const manager = new AgentManager([config], 10_000, () => adapter);
    try {
      const first = manager.start(config.id, 'first', 'sess-q', undefined, true, undefined, true);
      await vi.waitFor(() => expect(prompts).toEqual(['first']));
      expect(first.queued).toBeUndefined();

      const second = manager.start(config.id, 'second', 'sess-q', undefined, true, undefined, true);
      const third = manager.start(config.id, 'third', 'sess-q', undefined, true, undefined, true);
      const fourth = manager.start(config.id, 'fourth', 'sess-q', undefined, true, undefined, true);
      expect(second).toMatchObject({ status: 'queued', queued: true, prompt: 'second' });
      expect(third).toMatchObject({ status: 'queued', queued: true, prompt: 'third' });
      expect(prompts).toEqual(['first']);

      // Removing a queued message does not call adapter.cancel or interrupt the running turn
      const removed = manager.removeQueued(second.id);
      expect(removed).toMatchObject({ status: 'cancelled' });
      expect(second.queued).toBeUndefined();
      expect(cancelSpy).not.toHaveBeenCalled();

      // Completing the first turn automatically starts the third turn
      resolvers.get('first')!();
      expect((await manager.wait(first.id)).text).toBe('reply:first');
      await vi.waitFor(() => expect(prompts).toEqual(['first', 'third']));
      expect(third.queued).toBeUndefined();
      expect(manager.removeQueued(third.id)).toBeUndefined();
      expect(cancelSpy).not.toHaveBeenCalled();
      expect(fourth.queued).toBe(true);
      resolvers.get('third')!();
      expect((await manager.wait(third.id)).text).toBe('reply:third');
      await vi.waitFor(() => expect(prompts).toEqual(['first', 'third', 'fourth']));
      resolvers.get('fourth')!();
      expect((await manager.wait(fourth.id)).text).toBe('reply:fourth');
    } finally {
      await manager.close();
    }
  });

  it('cancels remaining queued messages when the active turn fails or is stopped and blocks queueing while stopping', async () => {
    let releaseFirst!: (mode: 'fail' | 'complete') => void;
    class FailureAdapter extends FakeAdapter {
      override async *prompt(
        _sessionId: string | undefined,
        text?: string,
        signal?: AbortSignal,
      ): AsyncIterable<AgentEvent> {
        if (text === 'will-fail') {
          const outcome = await new Promise<'fail' | 'complete'>((resolve) => {
            releaseFirst = resolve;
          });
          if (outcome === 'fail') {
            yield { type: 'error', text: 'upstream boom' };
            return;
          }
          yield { type: 'final', text: 'ok' };
          return;
        }
        await new Promise<void>((_, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }
    }
    const adapter = new FailureAdapter(config.id);
    const manager = new AgentManager([config], 10_000, () => adapter);
    try {
      const failing = manager.start(config.id, 'will-fail', 'sess-fail', undefined, true, undefined, true);
      await vi.waitFor(() => expect(releaseFirst).toBeTypeOf('function'));
      const queuedAfterFail = manager.start(config.id, 'follow-up', 'sess-fail', undefined, true, undefined, true);
      releaseFirst('fail');
      expect((await manager.wait(failing.id)).status).toBe('failed');
      const cancelledFollowUp = await manager.wait(queuedAfterFail.id);
      expect(cancelledFollowUp.status).toBe('cancelled');
      expect(cancelledFollowUp.queued).toBeUndefined();
      expect(cancelledFollowUp.error).toMatch(/previous message failed/);

      // Stopping an active turn cancels queued items and prevents queueing while unconfirmed
      vi.spyOn(adapter, 'cancel').mockRejectedValueOnce(new Error('stop failed'));
      const active = manager.start(config.id, 'will-stop', 'sess-stop', undefined, true, undefined, true);
      await vi.waitFor(() => expect(active.status).toBe('running'));
      const queuedAfterStop = manager.start(config.id, 'queued-stop', 'sess-stop', undefined, true, undefined, true);
      await expect(manager.cancel(active.id)).rejects.toThrow('stop failed');
      await manager.wait(active.id);
      const stoppedFollowUp = await manager.wait(queuedAfterStop.id);
      expect(stoppedFollowUp.status).toBe('cancelled');
      expect(stoppedFollowUp.error).toMatch(/previous message was stopped/);
      expect(() =>
        manager.start(config.id, 'blocked-by-unconfirmed', 'sess-stop', undefined, true, undefined, true),
      ).toThrow(/active or cancelling job/);
    } finally {
      await manager.close();
    }
  });

  it.each(['failure', 'replacement'])('settles the correct queue after a %s', async (scenario) => {
    let finishFirst!: (event: AgentEvent) => void;
    let finishSecond!: (event: AgentEvent) => void;
    const firstResult = new Promise<AgentEvent>((resolve) => {
      finishFirst = resolve;
    });
    const secondResult = new Promise<AgentEvent>((resolve) => {
      finishSecond = resolve;
    });
    class GateAdapter extends FakeAdapter {
      override async *prompt(_sessionId: string | undefined, text?: string): AsyncIterable<AgentEvent> {
        if (text === 'first') yield await firstResult;
        else if (text === 'second') yield await secondResult;
        else yield { type: 'final', text: 'follow-up reply' };
      }
    }
    const manager = new AgentManager([config], 10_000, () => new GateAdapter(config.id));
    try {
      const first = manager.start(config.id, 'first', 'same-session');
      if (scenario === 'replacement') {
        const oldQueued = manager.start(config.id, 'old follow-up', 'same-session', undefined, true, undefined, true);
        await manager.upsert({ ...config, port: 9000 });
        expect((await manager.wait(oldQueued.id)).status).toBe('cancelled');
      }
      const second = manager.start(config.id, 'second', 'same-session');
      const queued = manager.start(config.id, 'follow-up', 'same-session', undefined, true, undefined, true);
      finishFirst({ type: 'error', text: 'first failed' });
      await manager.wait(first.id);
      expect(queued.status).toBe(scenario === 'failure' ? 'cancelled' : 'queued');
      finishSecond({ type: 'final', text: 'second succeeded' });
      await manager.wait(second.id);
      const settled = await manager.wait(queued.id);
      if (scenario === 'failure') {
        expect(settled).toMatchObject({ status: 'cancelled', error: 'Cancelled because the previous message failed' });
      } else {
        expect(settled).toMatchObject({ status: 'completed', text: 'follow-up reply' });
      }
    } finally {
      finishFirst({ type: 'final' });
      finishSecond({ type: 'final' });
      await manager.close();
    }
  });

  it('enforces the per-session queue limit and cancels queued turns on close', async () => {
    const adapter = new RunningAdapter(config.id);
    const manager = new AgentManager([config], 10_000, () => adapter);
    const active = manager.start(config.id, 'first', 'sess-cap', undefined, true, undefined, true);
    await vi.waitFor(() => expect(active.text).toBe('partial reply'));
    expect(() => manager.start(config.id, '字'.repeat(22_000), 'sess-cap', undefined, true, undefined, true)).toThrow(
      /at most 65536 bytes/,
    );
    const queued: AgentJob[] = [
      manager.start(config.id, 'x'.repeat(65_536), 'sess-cap', undefined, true, undefined, true),
    ];
    for (let i = 1; i < 20; i++) {
      queued.push(manager.start(config.id, `queued-${i}`, 'sess-cap', undefined, true, undefined, true));
    }
    expect(() => manager.start(config.id, 'overflow', 'sess-cap', undefined, true, undefined, true)).toThrow(
      /Too many queued messages/,
    );
    await manager.close();
    for (const item of queued) {
      expect(item.status).toBe('cancelled');
      expect(item.queued).toBeUndefined();
    }
  });
});
