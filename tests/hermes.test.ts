import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { HermesAdapter } from '../src/adapters/hermes.js';
import { readSse } from '../src/adapters/sse.js';
import type { HttpRequest, HttpResponse, Transport } from '../src/types.js';

function incoming(text: string): IncomingMessage {
  return Object.assign(Readable.from([text]), { statusCode: 200, headers: {} }) as IncomingMessage;
}

class FakeTransport implements Transport {
  readonly kind = 'local' as const;
  requests: HttpRequest[] = [];
  async request(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    if (request.path === '/health') return { status: 200, headers: {}, text: '{"ok":true}' };
    if (request.path === '/v1/models') return { status: 200, headers: {}, text: '{"object":"list","data":[]}' };
    if (request.path === '/api/sessions?source=api_server')
      return { status: 200, headers: {}, text: '[{"session_id":"s1","title":"Research"}]' };
    if (request.path === '/v1/runs') return { status: 202, headers: {}, text: '{"run_id":"run_1","status":"started"}' };
    if (request.path === '/v1/runs/run_1/stop') return { status: 200, headers: {}, text: '{}' };
    if (request.path === '/v1/runs/run_1/approval') return { status: 200, headers: {}, text: '{}' };
    return { status: 200, headers: {}, text: '{"status":"completed","output":"done"}' };
  }
  async stream(): Promise<IncomingMessage> {
    return incoming(
      ': open\n\ndata: {"type":"message.delta","delta":"Hello "}\n\ndata: {"type":"tool.complete","name":"bash"}\n\ndata: {"type":"run.completed","output":"Hello world","completed":true}\n\n',
    );
  }
  async close(): Promise<void> {}
}

describe('Hermes API Server adapter', () => {
  it('verifies credentials and requests only resumable API sessions through the direct endpoint', async () => {
    const server = createServer((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/health') {
        response.end('{"status":"ok","platform":"hermes-agent"}');
      } else if (request.headers.authorization !== 'Bearer hermes-test-key') {
        response.writeHead(401).end('{"error":{"message":"Invalid API key"}}');
      } else if (request.url === '/v1/models') {
        response.end('{"object":"list","data":[{"id":"hermes-agent"}]}');
      } else if (request.url === '/api/sessions?source=api_server') {
        response.end('{"sessions":[{"id":"api-chat","source":"api_server","title":"Remote chat"}]}');
      } else {
        response.writeHead(404).end('{}');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const config = { id: 'hermes', kind: 'hermes', transport: 'direct', host: '127.0.0.1', port } as const;
      const unauthorized = new HermesAdapter('hermes', { ...config, token: 'wrong-key' });
      await expect(unauthorized.health()).rejects.toThrow(/HTTP 401/);
      const authorized = new HermesAdapter('hermes', { ...config, token: 'hermes-test-key' });
      await expect(authorized.health()).resolves.toEqual({ status: 'ok', platform: 'hermes-agent' });
      await expect(authorized.listSessions()).resolves.toEqual([{ id: 'api-chat', title: 'Remote chat' }]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('starts a run and normalizes SSE events', async () => {
    const transport = new FakeTransport();
    const adapter = new HermesAdapter('hermes', { id: 'hermes', kind: 'hermes', transport: 'local' }, transport);
    expect(await adapter.health()).toEqual({ ok: true });
    expect(await adapter.listSessions()).toEqual([{ id: 's1', title: 'Research' }]);
    const events = [];
    for await (const event of adapter.prompt('session-1', 'Do research')) events.push(event);
    expect(events.map((event) => event.type)).toEqual(['text', 'tool', 'final']);
    expect(events.at(-1)?.text).toBe('Hello world');
    const start = transport.requests.find((request) => request.path === '/v1/runs')!;
    expect(start.body).toMatchObject({ input: 'Do research', session_id: 'session-1' });
    expect(start.headers!['Idempotency-Key']).toBeTruthy();
  });

  it('supports cancellation and approvals', async () => {
    const transport = new FakeTransport();
    const adapter = new HermesAdapter('hermes', { id: 'hermes', kind: 'hermes', transport: 'local' }, transport);
    for await (const _ of adapter.prompt('session-1', 'task')) void _;
    await adapter.respond('session-1', 'request-1', 'once');
    await adapter.cancel('session-1');
    expect(
      transport.requests.some(
        (request) => request.path.endsWith('/approval') && (request.body as any)?.choice === 'once',
      ),
    ).toBe(true);
    expect(transport.requests.some((request) => request.path.endsWith('/stop'))).toBe(true);
  });

  it('ignores approval.responded events and maps run.cancelled to cancelled final', async () => {
    class CancelAndRespondedTransport extends FakeTransport {
      override async stream(): Promise<IncomingMessage> {
        return incoming(
          'data: {"type":"approval.required","request_id":"req-1","description":"Run rm?","choices":["approve","deny"]}\n\n' +
            'data: {"type":"approval.responded","request_id":"req-1","choice":"approve"}\n\n' +
            'data: {"type":"run.cancelled","output":"partial"}\n\n',
        );
      }
    }
    const adapter = new HermesAdapter(
      'hermes',
      { id: 'hermes', kind: 'hermes', transport: 'local' },
      new CancelAndRespondedTransport(),
    );
    const events = [];
    for await (const event of adapter.prompt('session-1', 'task')) events.push(event);
    expect(events.filter((e) => e.type === 'approval')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'final', text: 'partial', stopReason: 'cancelled' });

    // Status fallback also maps cancelled to final/cancelled instead of error
    class CancelledFallbackTransport extends FakeTransport {
      override async stream(): Promise<IncomingMessage> {
        return incoming(': empty stream ended early\n\n');
      }
      override async request(request: HttpRequest): Promise<HttpResponse> {
        if (request.path === '/v1/runs/run_1') {
          return { status: 200, headers: {}, text: '{"status":"cancelled","output":"partial-fallback"}' };
        }
        return super.request(request);
      }
    }
    const fallbackAdapter = new HermesAdapter(
      'hermes',
      { id: 'hermes', kind: 'hermes', transport: 'local' },
      new CancelledFallbackTransport(),
    );
    const fbEvents = [];
    for await (const event of fallbackAdapter.prompt('session-1', 'task')) fbEvents.push(event);
    expect(fbEvents.at(-1)).toMatchObject({ type: 'final', text: 'partial-fallback', stopReason: 'cancelled' });
  });
});

describe('SSE parser', () => {
  it('handles comments, multi-line data and event ids', async () => {
    const frames = [];
    for await (const frame of readSse(incoming(': hi\nid: 4\nevent: message\ndata: one\ndata: two\n\n')))
      frames.push(frame);
    expect(frames).toEqual([{ id: '4', event: 'message', data: 'one\ntwo' }]);
  });
});
