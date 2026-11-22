import { afterEach, describe, expect, it } from 'vitest';
import { DshAdapter } from '../src/adapters/dsh.js';
import type { HttpRequest, HttpResponse, Transport } from '../src/types.js';

class FakeTransport implements Transport {
  readonly kind = 'local' as const;
  readonly calls: HttpRequest[] = [];
  closed = false;
  private waitSeq = 6;

  async request(input: HttpRequest): Promise<HttpResponse> {
    this.calls.push(input);
    if (input.path.startsWith('/connect?')) {
      return { status: 302, headers: { 'set-cookie': 'dsh-cookie=secret; Path=/; HttpOnly' }, text: '' };
    }
    expect(input.headers?.Cookie).toBe('dsh-cookie=secret');
    const body = input.body as any;
    expect(body.type).toBe('client-request');
    expect(body.method).toBe(input.path.replace('/api/', ''));
    const args = body.payload.args;
    switch (body.method) {
      case 'session/list':
        expect(args).toEqual({ _request: {} });
        return ok({ items: [{ sessionId: 'dsh-session-1', title: 'Remote' }] });
      case 'session/create':
        return ok({ sessionId: args.request.sessionId, agentPreset: 'default' });
      case 'session/selectModel':
        return ok({ selected: { provider: args.request.provider, model: args.request.model } });
      case 'session/prompt':
        expect(args.request.content).toEqual([{ type: 'text', text: 'remember AL-TEST' }]);
        return ok({ accepted: true });
      case 'session/events':
        return ok({
          cursor: 5,
          hasMore: false,
          records: [
            {
              type: 'event',
              event: {
                type: 'assistant/message',
                seq: 5,
                data: { message: { content: [{ type: 'text', text: 'OLD-ANSWER' }] } },
              },
            },
          ],
        });
      case 'session/wait': {
        const nextSeq = ++this.waitSeq;
        return ok({
          reason: 'idle',
          state: { cursor: nextSeq, active: false, running: false },
          output: {
            records: [
              // Newest-to-oldest order including a stale record from seq 5
              {
                type: 'event',
                event: {
                  type: 'assistant/message',
                  seq: nextSeq,
                  data: { message: { content: [{ type: 'text', text: 'AL-TEST' }] } },
                },
              },
              {
                type: 'event',
                event: {
                  type: 'assistant/message',
                  seq: 5,
                  data: { message: { content: [{ type: 'text', text: 'OLD-ANSWER' }] } },
                },
              },
            ],
            truncated: false,
          },
        });
      }
      case 'session/cancel':
        return ok({ accepted: true });
      default:
        throw new Error(`Unexpected method ${body.method}`);
    }
  }

  async stream(): Promise<never> {
    throw new Error('not used');
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

function ok(value: unknown): HttpResponse {
  return {
    status: 200,
    headers: {},
    text: JSON.stringify({ type: 'server-response', rpcId: 'test', result: { ok: true, value } }),
  };
}

afterEach(() => {
  delete process.env.DSH_GATEWAY_TOKEN;
});

describe('DSH adapter', () => {
  it('surfaces durable model failures when wait output is empty', async () => {
    process.env.DSH_GATEWAY_TOKEN = 'launch-token';
    class FailingTransport extends FakeTransport {
      override async request(input: HttpRequest): Promise<HttpResponse> {
        if (input.path === '/api/session/wait') {
          return ok({
            reason: 'idle',
            state: { cursor: 19, active: true, running: false, queue: [], pendingInput: [] },
            output: { records: [], truncated: false },
          });
        }
        if (input.path === '/api/session/events') {
          const req = (input.body as any)?.payload?.args?.request;
          if (!req?.throughSeq) return ok({ cursor: 10, hasMore: false, records: [] });
          return ok({
            cursor: 19,
            hasMore: false,
            records: [
              {
                type: 'event',
                event: {
                  type: 'turn/end',
                  seq: 19,
                  data: { reason: { kind: 'error', error: { message: '400: {"code":"1214"}' } } },
                },
              },
            ],
          });
        }
        return super.request(input);
      }
    }
    const adapter = new DshAdapter('remote', { id: 'remote', kind: 'dsh', transport: 'local' }, new FailingTransport());
    const events = [];
    for await (const event of adapter.prompt('dsh-session-1', 'remember AL-TEST')) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'error', text: '400: {"code":"1214"}' });

    // Second turn on the same session must advance afterSeq to 19 and NOT re-report turn 1's error
    const secondTurn = [];
    for await (const event of adapter.prompt('dsh-session-1', 'remember AL-TEST')) secondTurn.push(event);
    expect(secondTurn.at(-1)).toMatchObject({ type: 'final', text: '', stopReason: 'idle' });
  });

  it('uses native session RPC with an API cookie and returns assistant output', async () => {
    process.env.DSH_GATEWAY_TOKEN = 'launch-token';
    const transport = new FakeTransport();
    const adapter = new DshAdapter(
      'remote',
      {
        id: 'remote',
        kind: 'dsh',
        transport: 'local',
        model: 'glm-test',
        dshProvider: 'openai',
      },
      transport,
    );

    expect(await adapter.health()).toEqual({ ok: true, sessions: 1 });
    expect(await adapter.listSessions()).toEqual([{ id: 'dsh-session-1', title: 'Remote', updatedAt: undefined }]);

    // New session calls session/create once and reuses it on continuation
    const created = [];
    for await (const event of adapter.prompt(undefined, 'remember AL-TEST')) created.push(event);
    const createdId = created.at(-1)?.sessionId;
    expect(createdId).toBeTruthy();
    expect(created.at(-1)).toMatchObject({ type: 'final', text: 'AL-TEST', stopReason: 'idle' });
    const continued = [];
    for await (const event of adapter.prompt(createdId, 'remember AL-TEST')) continued.push(event);
    expect(continued.at(-1)).toMatchObject({
      type: 'final',
      text: 'AL-TEST',
      stopReason: 'idle',
      sessionId: createdId,
    });
    expect(transport.calls.filter((call) => (call.body as any)?.method === 'session/create')).toHaveLength(1);

    // Continuing an uncached historical session reads its cursor before prompt and ignores older turns
    const historical = [];
    for await (const event of adapter.prompt('dsh-session-1', 'remember AL-TEST')) historical.push(event);
    expect(historical.at(-1)).toMatchObject({
      type: 'final',
      text: 'AL-TEST',
      stopReason: 'idle',
      sessionId: 'dsh-session-1',
    });
    expect(historical.some((event) => event.text?.includes('OLD-ANSWER'))).toBe(false);
    const historicalWait = transport.calls.filter((call) => (call.body as any)?.method === 'session/wait').at(-1)
      ?.body as any;
    expect(historicalWait.payload.args.request.afterSeq).toBe(5);
    expect(transport.calls.filter((call) => (call.body as any)?.method === 'session/create')).toHaveLength(1);
    expect(transport.calls.some((call) => (call.body as any)?.method === 'session/selectModel')).toBe(true);
    expect(transport.calls.find((call) => call.path === '/api/session/wait')).toMatchObject({
      responseWaitMs: 30_000,
      body: { payload: { args: { request: { afterSeq: 0, timeoutMs: 30_000 } } } },
    });
    await adapter.cancel('dsh-session-1');
    await adapter.close();
    expect(transport.closed).toBe(true);
  });

  it('does not cache sessionId before initial cursor lookup succeeds on historical continuation', async () => {
    process.env.DSH_GATEWAY_TOKEN = 'launch-token';
    let eventsCalls = 0;
    class FlakyCursorTransport extends FakeTransport {
      override async request(input: HttpRequest): Promise<HttpResponse> {
        if (input.path === '/api/session/events') {
          eventsCalls++;
          if (eventsCalls === 1) throw new Error('transient events failure');
        }
        return super.request(input);
      }
    }
    const transport = new FlakyCursorTransport();
    const adapter = new DshAdapter('remote', { id: 'remote', kind: 'dsh', transport: 'local' }, transport);

    const firstAttempt = [];
    for await (const event of adapter.prompt('dsh-session-1', 'remember AL-TEST')) firstAttempt.push(event);
    expect(firstAttempt.at(-1)).toMatchObject({ type: 'error', text: 'transient events failure' });

    const retry = [];
    for await (const event of adapter.prompt('dsh-session-1', 'remember AL-TEST')) retry.push(event);
    expect(retry.at(-1)).toMatchObject({ type: 'final', text: 'AL-TEST', sessionId: 'dsh-session-1' });
    expect(retry.some((event) => event.text?.includes('OLD-ANSWER'))).toBe(false);
    const waitCall = transport.calls.find((call) => (call.body as any)?.method === 'session/wait')?.body as any;
    expect(waitCall.payload.args.request.afterSeq).toBe(5);
  });

  it('rejects aborted health() before starting /connect and reports input-required as error', async () => {
    process.env.DSH_GATEWAY_TOKEN = 'launch-token';
    class InputRequiredTransport extends FakeTransport {
      override async request(input: HttpRequest): Promise<HttpResponse> {
        if (input.path === '/api/session/wait') {
          return ok({
            reason: 'input-required',
            state: { cursor: 9, active: true, running: false },
            output: { records: [], truncated: false },
          });
        }
        return super.request(input);
      }
    }
    const transport = new InputRequiredTransport();
    const adapter = new DshAdapter('remote', { id: 'remote', kind: 'dsh', transport: 'local' }, transport);

    const aborted = new AbortController();
    aborted.abort(new Error('already aborted'));
    await expect(adapter.health(aborted.signal)).rejects.toThrow(/already aborted/);
    expect(transport.calls).toHaveLength(0);

    const events = [];
    for await (const event of adapter.prompt(undefined, 'remember AL-TEST')) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'error', stopReason: 'input-required' });
  });
});
