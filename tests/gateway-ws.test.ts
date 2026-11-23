import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { OpenClawAdapter } from '../src/adapters/openclaw.js';
import { normalizeConfig } from '../src/config.js';

let server: WebSocketServer | undefined;
afterEach(async () => {
  if (server) {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  server = undefined;
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
  delete process.env.DSH_KNOT_STATE_DIR;
});

describe('OpenClaw WebSocket wire protocol', () => {
  it.each(['ok', 'timeout'])(
    'streams thought and tool events separately and preserves the %s terminal result',
    async (status) => {
      const received: any[] = [];
      const waitTimes: number[] = [];
      server = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/gateway/', handleProtocols: () => 'json' });
      server.on('connection', (socket, request) => {
        expect(request.headers.origin).toBeUndefined();
        socket.send(
          JSON.stringify({
            type: 'event',
            event: 'connect.challenge',
            payload: { nonce: 'wire-nonce', ts: 1737264000000 },
          }),
        );
        socket.on('message', (data) => {
          const frame = JSON.parse(data.toString());
          received.push(frame);
          if (frame.method === 'connect') {
            expect(frame.params.device.nonce).toBe('wire-nonce');
            expect(frame.params.device.signature).not.toBe('');
            expect(frame.params.device.signedAt).toBe(1737264000000);
            expect(frame.params.caps).toContain('tool-events');
            socket.send(JSON.stringify({ type: 'res', id: frame.id, ok: true, payload: { type: 'hello-ok' } }));
          } else if (frame.method === 'health') {
            socket.send(JSON.stringify({ type: 'res', id: frame.id, ok: true, payload: { ok: true } }));
          } else if (frame.method === 'sessions.create') {
            socket.send(
              JSON.stringify({ type: 'res', id: frame.id, ok: true, payload: { sessionKey: frame.params.key } }),
            );
          } else if (frame.method === 'agent') {
            socket.send(
              JSON.stringify({
                type: 'res',
                id: frame.id,
                ok: true,
                payload: { runId: 'run-wire', sessionKey: frame.params.sessionKey },
              }),
            );
          } else if (frame.method === 'agent.wait') {
            waitTimes.push(performance.now());
            if (waitTimes.length < 3) {
              const interim = waitTimes.length === 1 ? 'pending' : 'timeout';
              socket.send(JSON.stringify({ type: 'res', id: frame.id, ok: true, payload: { status: interim } }));
              return;
            }
            // Deliver the process frames and terminal response in the same socket write.
            request.socket.cork();
            for (const [runId, itemId, text, delta] of [
              ['other-run', 'item-1', 'bad thought', 'bad thought'],
              ['run-wire', 'item-1', 'Check', 'Check'],
              ['run-wire', 'item-1', 'Check the weather.', ' the weather.'],
              ['run-wire', 'item-1', 'Check the weather. Search.', 'Check the weather. Search.'],
              ['run-wire', 'item-2', 'Verify.', 'Verify.'],
            ]) {
              socket.send(
                JSON.stringify({
                  type: 'event',
                  event: 'agent',
                  payload: { runId, stream: 'thinking', data: { itemId, text, delta } },
                }),
              );
            }
            socket.send(
              JSON.stringify({
                type: 'event',
                event: 'agent',
                payload: { runId: 'run-wire', type: 'message.delta', delta: 'wire ' },
              }),
            );
            for (const phase of ['start', 'result']) {
              socket.send(
                JSON.stringify({
                  type: 'event',
                  event: 'agent',
                  payload: {
                    runId: 'run-wire',
                    stream: 'tool',
                    data: {
                      phase,
                      name: 'search',
                      toolCallId: 'tool-wire',
                      isError: phase === 'result',
                      args: { query: 'weather', password: 'secret-value', page: 1 },
                    },
                  },
                }),
              );
            }
            socket.send(
              JSON.stringify({
                type: 'res',
                id: frame.id,
                ok: true,
                payload:
                  status === 'timeout'
                    ? { status, endedAt: 1737264000001, terminalReply: { text: 'wire partial' } }
                    : { status, terminalReply: { text: 'wire result' } },
              }),
            );
            request.socket.uncork();
          }
        });
      });
      await new Promise<void>((resolve) => server!.once('listening', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('expected TCP address');
      process.env.OPENCLAW_GATEWAY_TOKEN = 'token';
      process.env.DSH_KNOT_STATE_DIR = mkdtempSync(join(tmpdir(), 'dsh-knot-wire-'));
      const [config] = normalizeConfig({
        agents: [{ id: 'wire', kind: 'openclaw', host: `ws://127.0.0.1:${address.port}/gateway/` }],
      }).agents;
      const adapter = new OpenClawAdapter('wire', config!);
      expect(await adapter.health()).toEqual({ ok: true });
      const events = [];
      for await (const event of adapter.prompt('agent:main:wire', 'hello')) events.push(event);
      expect(events.filter((event) => event.type === 'thought').map(({ text }) => text)).toEqual([
        'Check',
        ' the weather.',
        ' Search.',
        '\n\nVerify.',
      ]);
      const textEvents = events.filter((event) => event.type === 'text');
      expect(textEvents).toEqual(
        status === 'timeout'
          ? [
              { type: 'text', text: 'wire ' },
              { type: 'text', text: 'partial' },
            ]
          : [{ type: 'text', text: 'wire ' }],
      );
      expect(events.filter((event) => event.type === 'tool')).toEqual([
        {
          type: 'tool',
          phase: 'start',
          name: 'search',
          requestId: 'tool-wire',
          inputPreview: JSON.stringify({ query: 'weather', password: '[REDACTED]', page: 1 }, null, 2),
        },
        { type: 'tool', phase: 'end', name: 'search', requestId: 'tool-wire', failed: true },
      ]);
      expect(events.at(-1)).toMatchObject(
        status === 'timeout'
          ? { type: 'error', text: 'OpenClaw run ended with status "timeout"', stopReason: 'timeout' }
          : { type: 'final', text: 'wire result' },
      );
      expect(waitTimes).toHaveLength(3);
      expect(waitTimes[1]! - waitTimes[0]!).toBeGreaterThanOrEqual(200);
      expect(waitTimes[2]! - waitTimes[1]!).toBeGreaterThanOrEqual(200);
      expect(received.some((frame) => frame.method === 'agent' && frame.params.idempotencyKey)).toBe(true);
      await adapter.close();
    },
  );

  it('fails explicitly when an active subscriber queue overflows instead of silently dropping events', async () => {
    const { AsyncQueue } = await import('../src/async-queue.js');
    const active = new AsyncQueue<number>(2, 'error');
    active.push(1);
    active.push(2);
    active.push(3);
    expect((await active.next()).value).toBe(1);
    expect((await active.next()).value).toBe(2);
    await expect(active.next()).rejects.toThrow(/Event queue overflow/);

    const idle = new AsyncQueue<number>(2, 'drop-oldest');
    idle.push(1);
    idle.push(2);
    idle.push(3);
    expect((await idle.next()).value).toBe(2);
    expect((await idle.next()).value).toBe(3);
  });
});
