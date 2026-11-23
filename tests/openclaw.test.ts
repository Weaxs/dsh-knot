import { createPublicKey, verify as verifySignature } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GatewayWebSocket } from '../src/adapters/gateway-ws.js';
import { OpenClawAdapter } from '../src/adapters/openclaw.js';
import { loadOrCreateIdentity, signClaim } from '../src/adapters/openclaw-identity.js';
import { AsyncQueue } from '../src/async-queue.js';
import { LocalOnlyAbortError } from '../src/config.js';

class FakeGateway {
  calls: Array<{ method: string; params: any }> = [];
  private challenge = true;
  isOpen = false;
  async openWebSocket() {
    this.isOpen = true;
  }
  async nextEvent(): Promise<IteratorResult<Record<string, any>>> {
    if (this.challenge) {
      this.challenge = false;
      return {
        done: false,
        value: { type: 'event', event: 'connect.challenge', payload: { nonce: 'nonce-1', ts: 1737264000000 } },
      };
    }
    return {
      done: false,
      value: { type: 'event', event: 'agent', payload: { runId: 'run-1', type: 'message.delta', delta: 'ok' } },
    };
  }
  subscribeEvents(): ReturnType<GatewayWebSocket['subscribeEvents']> {
    let active = true;
    return {
      next: () => (active ? this.nextEvent() : Promise.resolve({ done: true, value: undefined })),
      unsubscribe: () => {
        active = false;
      },
    };
  }
  async request(method: string, params: any) {
    this.calls.push({ method, params });
    if (method === 'connect') return { type: 'hello-ok' };
    if (method === 'health') return { ok: true };
    if (method === 'sessions.list') return { sessions: [{ key: 'agent:main:main', displayName: 'Main' }] };
    if (method === 'sessions.create') return { sessionKey: params.key };
    if (method === 'agent') return { runId: 'run-1', sessionKey: params.sessionKey };
    if (method === 'agent.wait') return { status: 'ok', terminalReply: { text: 'finished' } };
    if (method === 'sessions.abort') return {};
    throw new Error(`unexpected ${method}`);
  }
  async close() {
    this.isOpen = false;
  }
}

afterEach(() => {
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
  delete process.env.DSH_KNOT_STATE_DIR;
});

describe('OpenClaw adapter', () => {
  it('pairs with a nonce signature and reuses the session', async () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = 'token';
    process.env.DSH_KNOT_STATE_DIR = mkdtempSync(join(tmpdir(), 'dsh-knot-'));
    const gateway = new FakeGateway();
    const adapter = new OpenClawAdapter(
      'claw',
      { id: 'claw', kind: 'openclaw', transport: 'local' },
      undefined,
      gateway as any,
    );
    expect(await adapter.health()).toEqual({ ok: true });
    const connect = gateway.calls.find((call) => call.method === 'connect')!;
    expect(connect.params.device.signature).not.toBe('');
    expect(connect.params.device.nonce).toBe('nonce-1');
    expect(connect.params.device.signedAt).toBe(1737264000000);
    expect(connect.params.minProtocol).toBe(4);
    expect(connect.params.maxProtocol).toBe(4);
    expect(connect.params.auth.token).toBe('token');
    const events = [];
    for await (const event of adapter.prompt('agent:main:test', 'work')) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'final', text: 'finished' });
    expect(gateway.calls.find((call) => call.method === 'agent')?.params.sessionKey).toBe('agent:main:test');
    await adapter.cancel('agent:main:test');
    expect(gateway.calls.at(-1)?.method).toBe('sessions.abort');
  });

  it('isolates streamed text and approval lifecycle across concurrent runs', async () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = 'token';
    process.env.DSH_KNOT_STATE_DIR = mkdtempSync(join(tmpdir(), 'dsh-knot-'));
    const subscribers = new Set<AsyncQueue<Record<string, any>>>();
    let runSeq = 0;
    const waitResolvers = new Map<string, (val: Record<string, any>) => void>();
    const gateway = {
      isOpen: true,
      async openWebSocket() {
        this.isOpen = true;
      },
      async nextEvent() {
        return {
          done: false,
          value: { type: 'event', event: 'connect.challenge', payload: { nonce: 'n', ts: 1737264000000 } },
        };
      },
      subscribeEvents() {
        const q = new AsyncQueue<Record<string, any>>();
        subscribers.add(q);
        return {
          next: (sig?: AbortSignal) => q.next(sig),
          unsubscribe: () => {
            subscribers.delete(q);
            q.finish();
          },
        };
      },
      async request(method: string, params: any) {
        if (method === 'connect') return { type: 'hello-ok' };
        if (method === 'sessions.create') return { sessionKey: params.key };
        if (method === 'agent') {
          const runId = `run-${++runSeq}`;
          return { runId, sessionKey: params.sessionKey };
        }
        if (method === 'agent.wait') {
          return new Promise<Record<string, any>>((resolve) => {
            waitResolvers.set(params.runId, resolve);
          });
        }
        return {};
      },
      async close() {
        this.isOpen = false;
      },
    };
    const emit = (frame: Record<string, any>) => {
      for (const q of subscribers) q.push(frame);
    };
    const adapter = new OpenClawAdapter(
      'claw',
      { id: 'claw', kind: 'openclaw', transport: 'local' },
      undefined,
      gateway as any,
    );
    const collect = async (session: string, msg: string) => {
      const out = [];
      for await (const ev of adapter.prompt(session, msg)) out.push(ev);
      return out;
    };
    const p1 = collect('s1', 'task 1');
    const p2 = collect('s2', 'task 2');
    await vi.waitFor(() => expect(waitResolvers.size).toBe(2));
    emit({
      type: 'event',
      event: 'agent',
      payload: { runId: 'run-2', type: 'message.delta', data: { delta: 'from-2' } },
    });
    emit({ type: 'event', event: 'agent', payload: { runId: 'run-1', type: 'message.delta', delta: 'from-1' } });
    emit({ type: 'event', event: 'agent', payload: { type: 'message.delta', delta: 'unrouted' } });
    emit({
      type: 'event',
      event: 'exec.approval.requested',
      payload: { id: 'approval-1', request: { sessionKey: 's1', command: 'pwd' } },
    });
    emit({
      type: 'event',
      event: 'exec.approval.requested',
      payload: { id: 'approval-2', request: { sessionKey: 's2', runId: 'run-2', command: 'ls' } },
    });
    emit({
      type: 'event',
      event: 'exec.approval.requested',
      payload: { id: 'old-approval', request: { sessionKey: 's1', runId: 'old-run', command: 'pwd' } },
    });
    emit({
      type: 'event',
      event: 'exec.approval.requested',
      payload: { id: 'global-approval', request: { command: 'pwd' } },
    });
    emit({
      type: 'event',
      event: 'exec.approval.resolved',
      payload: { id: 'approval-1', request: { sessionKey: 's1', command: 'pwd' }, decision: 'deny' },
    });
    waitResolvers.get('run-1')!({ status: 'ok', terminalReply: { text: 'from-1' } });
    waitResolvers.get('run-2')!({ status: 'error', error: 'model crashed' });
    const [e1, e2] = await Promise.all([p1, p2]);
    expect(e1).toEqual([
      { type: 'text', text: 'from-1' },
      { type: 'approval', requestId: 'approval-1', text: 'pwd', choices: [] },
      { type: 'approval', phase: 'end', requestId: 'approval-1' },
      { type: 'final', text: 'from-1', stopReason: 'ok' },
    ]);
    expect(e2).toEqual([
      { type: 'text', text: 'from-2' },
      { type: 'approval', requestId: 'approval-2', text: 'ls', choices: [] },
      { type: 'error', text: 'model crashed', stopReason: 'error' },
    ]);
  });

  it.each([false, true])('cleans up a long stream on abort (local only: %s)', async (localOnly) => {
    process.env.OPENCLAW_GATEWAY_TOKEN = 'token';
    process.env.DSH_KNOT_STATE_DIR = mkdtempSync(join(tmpdir(), 'dsh-knot-'));
    const queue = new AsyncQueue<Record<string, unknown>>(1_024, 'error');
    let markWaitStarted!: (signal: AbortSignal) => void;
    const waitStarted = new Promise<AbortSignal>((resolve) => {
      markWaitStarted = resolve;
    });
    class WaitingGateway extends FakeGateway {
      override subscribeEvents() {
        return {
          next: (signal?: AbortSignal) => queue.next(signal),
          unsubscribe: () => queue.finish(),
        };
      }

      override request(method: string, params: any, _timeout?: number, signal?: AbortSignal): Promise<any> {
        if (method !== 'agent.wait') return super.request(method, params);
        markWaitStarted(signal!);
        return new Promise((_, reject) => {
          signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
        });
      }
    }
    const gateway = new WaitingGateway();
    const adapter = new OpenClawAdapter(
      'claw',
      { id: 'claw', kind: 'openclaw', transport: 'local' },
      undefined,
      gateway as any,
    );
    const controller = new AbortController();
    const iterator = adapter.prompt('long-session', 'work', controller.signal)[Symbol.asyncIterator]();
    let next = iterator.next();
    const waitSignal = await waitStarted;
    const frame = { type: 'event', event: 'agent', payload: { runId: 'run-1', delta: '.' } };
    let output = '';
    for (let index = 0; index < 2_048; index++) {
      queue.push(frame);
      output += (await next).value?.text;
      next = iterator.next();
    }
    expect(output).toBe('.'.repeat(2_048));
    controller.abort(localOnly ? new LocalOnlyAbortError('stop') : new Error('stop'));
    await expect(next).resolves.toMatchObject({ done: true });
    expect(waitSignal.aborted).toBe(true);
    await expect(queue.next()).resolves.toMatchObject({ done: true });
    expect(gateway.calls.filter(({ method }) => method === 'sessions.abort')).toEqual(
      localOnly ? [] : [{ method: 'sessions.abort', params: { key: 'long-session' } }],
    );
    await adapter.close();
  });

  it('fails the run when the subscriber queue overflows even if agent.wait resolves ok first', async () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = 'token';
    process.env.DSH_KNOT_STATE_DIR = mkdtempSync(join(tmpdir(), 'dsh-knot-'));
    const queue = new AsyncQueue<Record<string, any>>(1, 'error');
    const gateway = {
      isOpen: true,
      async openWebSocket() {
        this.isOpen = true;
      },
      async nextEvent() {
        return {
          done: false,
          value: { type: 'event', event: 'connect.challenge', payload: { nonce: 'n', ts: 1737264000000 } },
        };
      },
      subscribeEvents() {
        return {
          next: (sig?: AbortSignal) => queue.next(sig),
          unsubscribe: () => queue.finish(),
        };
      },
      async request(method: string, params: any) {
        if (method === 'connect') return { type: 'hello-ok' };
        if (method === 'sessions.create') return { sessionKey: params.key };
        if (method === 'agent') {
          queue.push({ type: 'event', event: 'agent', payload: { runId: 'run-overflow', delta: '1' } });
          queue.push({ type: 'event', event: 'agent', payload: { runId: 'run-overflow', delta: '2' } });
          return { runId: 'run-overflow', sessionKey: params.sessionKey };
        }
        if (method === 'agent.wait') return { status: 'ok', terminalReply: { text: 'partial' } };
        return {};
      },
      async close() {
        this.isOpen = false;
      },
    };
    const adapter = new OpenClawAdapter(
      'claw',
      { id: 'claw', kind: 'openclaw', transport: 'local' },
      undefined,
      gateway as any,
    );
    await expect(
      (async () => {
        for await (const _event of adapter.prompt('s-overflow', 'work')) {
          /* drain */
        }
      })(),
    ).rejects.toThrow(/Event queue overflow/);
  });
});

describe('device identity', () => {
  it('persists the key and signs the v2 claim', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-knot-id-'));
    const first = loadOrCreateIdentity('test', root);
    const second = loadOrCreateIdentity('test', root);
    expect(second.deviceId).toBe(first.deviceId);
    const signature = signClaim(first, 'nonce', 'token');
    expect(signature).toMatch(/^[a-zA-Z0-9_-]+$/);
    const payload = [
      'v2',
      first.deviceId,
      'cli',
      'cli',
      'operator',
      'operator.admin,operator.read,operator.write,operator.approvals,operator.pairing',
      String(first.signedAtMs),
      'token',
      'nonce',
    ].join('|');
    expect(
      verifySignature(
        null,
        Buffer.from(payload),
        createPublicKey({ key: first.publicKey as any, format: 'jwk' }),
        Buffer.from(signature, 'base64url'),
      ),
    ).toBe(true);
  });
});
