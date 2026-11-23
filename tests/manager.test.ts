import { describe, expect, it, vi } from 'vitest';
import { runDoctor } from '../src/doctor.js';
import { AgentManager } from '../src/manager.js';
import type { AgentAdapter, AgentConfig, AgentEvent } from '../src/types.js';

class FakeAdapter implements AgentAdapter {
  readonly kind = 'hermes' as const;
  cancelled = false;
  constructor(readonly id: string) {}
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

const config: AgentConfig = { id: 'remote', kind: 'hermes', transport: 'local' };

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

  it('keeps an exclusive Hermes session locked until a remote stop retry succeeds', async () => {
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
    const adapter = new RunningAdapter(config.id);
    vi.spyOn(adapter, 'cancel').mockRejectedValueOnce(new Error('Hermes remote stop is unconfirmed'));
    const manager = new AgentManager([config], 10_000, () => adapter);
    const job = manager.start(config.id, 'Hello', 'shared', undefined, true);
    await vi.waitFor(() => expect(job.text).toBe('partial reply'));
    await expect(manager.cancel(job.id)).rejects.toThrow('remote stop is unconfirmed');
    await manager.wait(job.id);
    expect(manager.getCurrentJob(config.id, job.id)?.remoteStop).toBe('unconfirmed');
    expect(() => manager.start(config.id, 'Next turn', 'shared', undefined, true)).toThrow(/active or cancelling job/);
    expect(await manager.cancel(job.id)).toMatchObject({ status: 'cancelled', text: 'partial reply' });
    expect(manager.getCurrentJob(config.id, job.id)?.remoteStop).toBeUndefined();
    await manager.close();
  });

  it('tracks jobs, approvals and completion notifications', async () => {
    const adapter = new FakeAdapter('remote');
    const manager = new AgentManager([config], 10_000, () => adapter);
    let notified = false;
    const job = manager.start('remote', 'work', undefined, () => {
      notified = true;
    });
    expect(job.sessionId).toMatch(/^dsh_/);
    const completed = await manager.wait(job.id);
    expect(completed.status).toBe('completed');
    expect(completed.text).toBe('part done');
    expect(notified).toBe(true);
    await expect(manager.respond(job.id, 'once', undefined, 'wrong-request')).rejects.toThrow(/no longer pending/);
    await expect(manager.respond(job.id, 'bogus-choice', undefined, 'r1')).rejects.toThrow(/Invalid approval choice/);
    await manager.respond(job.id, 'once', undefined, 'r1');
    expect(manager.get(job.id).pendingApproval).toBeUndefined();
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
        yield { type: 'tool', requestId: 'b', phase: 'start', name: 'read_file' };
        yield { type: 'tool', requestId: 'b', phase: 'start', inputPreview: 'MISSING.md' };
        yield { type: 'tool', requestId: 'c', phase: 'start', name: 'terminal' };
        await finishTurn;
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
      expect(job.tools?.map(({ status }) => status)).toEqual(['running', 'running', 'running']);
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
    const acpConfig: AgentConfig = { id: 'acp-remote', kind: 'acp', transport: 'local' };
    class HangingAcpAdapter implements AgentAdapter {
      readonly kind = 'acp' as const;
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
    const manager = new AgentManager([acpConfig], 10_000, () => new HangingAcpAdapter('acp-remote'));
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
    const acpConfig: AgentConfig = { id: 'acp-flaky', kind: 'acp', transport: 'local' };
    class FlakyAcpAdapter implements AgentAdapter {
      readonly kind = 'acp' as const;
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
    const manager = new AgentManager([acpConfig], 10_000, () => new FlakyAcpAdapter('acp-flaky'));
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
    const acpConfig: AgentConfig = { id: 'acp-reconfig', kind: 'acp', transport: 'local' };
    class TimeoutCancelAdapter implements AgentAdapter {
      readonly kind = 'acp' as const;
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
});
