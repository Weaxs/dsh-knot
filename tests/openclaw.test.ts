import { createPublicKey, verify as verifySignature } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenClawAdapter } from '../src/adapters/openclaw.js';
import { loadOrCreateIdentity, signClaim } from '../src/adapters/openclaw-identity.js';

class FakeGateway {
  calls: Array<{ method: string; params: any }> = [];
  private challenge = true;
  isOpen = false;
  async openWebSocket() {
    this.isOpen = true;
  }
  async nextEvent() {
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
  subscribeEvents() {
    let active = true;
    return {
      next: () => (active ? this.nextEvent() : Promise.resolve({ done: true, value: undefined })),
      error: () => undefined,
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

  it('fans out concurrent run events without stealing and reports terminal error status as error', async () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = 'token';
    process.env.DSH_KNOT_STATE_DIR = mkdtempSync(join(tmpdir(), 'dsh-knot-'));
    const { AsyncQueue } = await import('../src/async-queue.js');
    const subscribers = new Set<InstanceType<typeof AsyncQueue<Record<string, any>>>>();
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
    await new Promise((r) => setTimeout(r, 10));
    emit({
      type: 'event',
      event: 'agent',
      payload: { runId: 'run-2', type: 'message.delta', data: { delta: 'from-2' } },
    });
    emit({ type: 'event', event: 'agent', payload: { runId: 'run-1', type: 'message.delta', delta: 'from-1' } });
    await new Promise((r) => setTimeout(r, 10));
    waitResolvers.get('run-1')!({ status: 'ok', terminalReply: { text: 'from-1' } });
    waitResolvers.get('run-2')!({ status: 'error', error: 'model crashed' });
    const [e1, e2] = await Promise.all([p1, p2]);
    expect(e1.some((e) => e.type === 'text' && e.text === 'from-1')).toBe(true);
    expect(e1.at(-1)).toMatchObject({ type: 'final', text: 'from-1' });
    expect(e2.some((e) => e.type === 'text' && e.text === 'from-2')).toBe(true);
    expect(e2.at(-1)).toMatchObject({ type: 'error', text: 'model crashed', stopReason: 'error' });
  });

  it('fails the run when the subscriber queue overflows even if agent.wait resolves ok first', async () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = 'token';
    process.env.DSH_KNOT_STATE_DIR = mkdtempSync(join(tmpdir(), 'dsh-knot-'));
    const { AsyncQueue } = await import('../src/async-queue.js');
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
          error: () => queue.failure,
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
