import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeHttpTransport } from '../src/transports/http.js';

let server: http.Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

describe('HTTP transport', () => {
  it('sends JSON requests over the local transport', async () => {
    server = http.createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ method: request.method, body }));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const transport = new NodeHttpTransport('local', {
      id: 'x',
      kind: 'dsh',
      transport: 'local',
      host: '127.0.0.1',
      port,
    });
    const result = await transport.request({ method: 'POST', path: '/v1/test', body: { input: 'hello' } });
    expect(result.status).toBe(200);
    expect(JSON.parse(result.text)).toEqual({ method: 'POST', body: '{"input":"hello"}' });
  });

  it('prepends basePath on direct requests and bounds stalled headers with connectTimeoutMs', async () => {
    let seenUrl = '';
    server = http.createServer((request, response) => {
      seenUrl = request.url ?? '';
      if (seenUrl.endsWith('/stall')) return;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ url: seenUrl }));
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const transport = new NodeHttpTransport('direct', {
      id: 'ts',
      kind: 'dsh',
      transport: 'direct',
      host: '127.0.0.1',
      port,
      basePath: '/hermes',
      connectTimeoutMs: 120,
    });
    const ok = await transport.request({ path: '/health' });
    expect(JSON.parse(ok.text)).toEqual({ url: '/hermes/health' });
    await expect(transport.request({ path: '/stall' })).rejects.toThrow(/timed out/);
  });

  it('bounds a stalled HTTP error body', async () => {
    server = http.createServer((_request, response) => {
      response.writeHead(503);
      response.flushHeaders();
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const transport = new NodeHttpTransport('local', { id: 'x', kind: 'dsh', port, connectTimeoutMs: 120 });
    await expect(transport.request({ path: '/health' })).rejects.toThrow(/timed out/);
  });

  it('allows additional time for a deferred HTTP response', async () => {
    server = http.createServer((_request, response) => {
      const timer = setTimeout(() => response.end('ready'), 200);
      response.once('close', () => clearTimeout(timer));
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const transport = new NodeHttpTransport('local', { id: 'x', kind: 'dsh', port, connectTimeoutMs: 100 });
    await expect(transport.request({ path: '/wait', responseWaitMs: 1_000 })).resolves.toMatchObject({ text: 'ready' });
  });
});
