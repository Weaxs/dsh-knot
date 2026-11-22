import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { AcpBridge } from '../src/acp/bridge.js';
import { AcpAdapter } from '../src/adapters/acp.js';
import { normalizeConfig } from '../src/config.js';
import type { AgentAdapter, AgentEvent, AgentSession } from '../src/types.js';

class FakeNativeAdapter implements AgentAdapter {
  readonly kind = 'hermes' as const;
  readonly prompts: Array<{ sessionId: string; text: string }> = [];
  choice?: string;
  cancelled = false;

  constructor(readonly id = 'native') {}

  async health() {
    return { ok: true };
  }

  async listSessions(): Promise<AgentSession[]> {
    return [{ id: this.prompts[0]?.sessionId ?? 'session-1', title: 'ACP session', updatedAt: 1767225600000 }];
  }

  async *prompt(sessionId: string | undefined, text: string): AsyncIterable<AgentEvent> {
    this.prompts.push({ sessionId: sessionId ?? '', text });
    yield { type: 'text', text: 'hello ' };
    yield { type: 'tool', phase: 'start', requestId: 'tool-1', name: 'test-tool' };
    yield { type: 'tool', phase: 'end', requestId: 'tool-1', name: 'test-tool' };
    yield { type: 'approval', requestId: 'permission-1', choices: ['approve', 'reject'], text: 'Allow the test?' };
    while (!this.choice) await new Promise((resolve) => setTimeout(resolve, 1));
    yield { type: 'text', text: 'world' };
    yield { type: 'final', text: 'hello world', stopReason: 'completed' };
  }

  async cancel() {
    this.cancelled = true;
  }

  async respond(_sessionId: string, _requestId: string, choice: string) {
    this.choice = choice;
  }

  async close() {}
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe('ACP provider and bridge', () => {
  it('uses the exact endpoint and waits for one initialization before allowing concurrent requests', async () => {
    let entered!: () => void;
    let release!: () => void;
    const initializing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const native = new FakeNativeAdapter();
    native.health = async () => {
      entered();
      await ready;
      return { ok: true };
    };
    const bridge = new AcpBridge({ id: 'native', kind: 'hermes' }, () => native);
    const address = await bridge.start({ port: 0, token: 'acp-test-token' });
    const [config] = normalizeConfig({
      agents: [{ id: 'exact', kind: 'acp', host: `ws://${address.host}:${address.port}/acp`, token: 'acp-test-token' }],
    }).agents;
    const adapter = new AcpAdapter('exact', config!);
    cleanups.push(async () => {
      release();
      await adapter.close();
      await bridge.close();
    });

    const health = adapter.health();
    await Promise.race([health, initializing]);
    const sessions = adapter.listSessions();
    release();
    const [verified, listed] = await Promise.all([health, sessions]);
    expect(verified).toMatchObject({ ok: true, protocolVersion: 1 });
    expect(listed).toMatchObject([{ id: 'session-1' }]);
  });

  it('runs prompts, continuations, tools and permissions over the official ACP WebSocket transport', async () => {
    const native = new FakeNativeAdapter();
    const listSessions = native.listSessions.bind(native);
    native.listSessions = async () => [...(await listSessions()), { id: 'undated', updatedAt: 'unavailable' }];
    const bridge = new AcpBridge({ id: 'native', kind: 'hermes' }, () => native);
    const address = await bridge.start({ port: 0, token: 'acp-test-token' });
    const adapter = new AcpAdapter('unified', {
      id: 'unified',
      kind: 'acp',
      transport: 'local',
      host: address.host,
      port: address.port,
      token: 'acp-test-token',
    });
    cleanups.push(async () => {
      await adapter.close();
      await bridge.close();
    });

    expect(await adapter.health()).toMatchObject({
      ok: true,
      protocol: 'acp',
      protocolVersion: 1,
      capabilities: { loadSession: false, sessionCapabilities: { list: {}, resume: {} } },
    });
    const first = [];
    for await (const event of adapter.prompt(undefined, 'first prompt')) {
      first.push(event);
      if (event.type === 'approval') await adapter.respond(event.sessionId!, event.requestId!, 'approve');
    }
    const createdSessionId = first.at(-1)?.sessionId;
    expect(createdSessionId).toBeTruthy();
    expect(first.at(-1)).toMatchObject({ type: 'final', text: 'hello world', stopReason: 'end_turn' });
    expect(first.filter((event) => event.type === 'tool')).toHaveLength(2);
    expect(native.choice).toBe('approve');

    native.choice = undefined;
    const second = [];
    for await (const event of adapter.prompt(createdSessionId, 'continuation')) {
      second.push(event);
      if (event.type === 'approval') await adapter.respond(createdSessionId!, event.requestId!, 'approve');
    }
    expect(second.at(-1)).toMatchObject({ type: 'final', text: 'hello world', sessionId: createdSessionId });
    expect(native.prompts.map((prompt) => prompt.text)).toEqual(['first prompt', 'continuation']);
    expect(new Set(native.prompts.map((prompt) => prompt.sessionId)).size).toBe(1);
    expect(await adapter.listSessions()).toEqual([
      {
        id: native.prompts[0]!.sessionId,
        title: 'ACP session',
        cwd: '/',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      { id: 'undated', cwd: '/' },
    ]);

    // A fresh adapter (empty cache) resumes the historical session via session/load without changing sessionId
    const freshAdapter = new AcpAdapter('unified-fresh', {
      id: 'unified-fresh',
      kind: 'acp',
      transport: 'local',
      host: address.host,
      port: address.port,
      token: 'acp-test-token',
    });
    cleanups.push(() => freshAdapter.close());
    native.choice = undefined;
    const resumed = [];
    for await (const event of freshAdapter.prompt(createdSessionId, 'resumed after restart')) {
      resumed.push(event);
      if (event.type === 'approval') await freshAdapter.respond(createdSessionId!, event.requestId!, 'approve');
    }
    expect(resumed.at(-1)).toMatchObject({ type: 'final', text: 'hello world', sessionId: createdSessionId });
    expect(native.prompts.at(-1)?.sessionId).toBe(createdSessionId);

    // Responding with the wrong sessionId is isolated and rejected
    await expect(freshAdapter.respond('other-session', 'permission-1', 'approve')).rejects.toThrow(
      /No pending ACP permission request/,
    );

    // Resuming a nonexistent session fails honestly instead of silently accepting
    const missing = [];
    for await (const event of freshAdapter.prompt('does-not-exist', 'hello')) missing.push(event);
    expect(missing.at(-1)).toMatchObject({ type: 'error' });
    expect(missing.at(-1)?.text).toMatch(/not found/);
  });

  it('propagates cancellation through ACP session/cancel', async () => {
    class SlowAdapter extends FakeNativeAdapter {
      override async *prompt(sessionId: string | undefined): AsyncIterable<AgentEvent> {
        void sessionId;
        yield { type: 'text', text: 'working' };
        while (!this.cancelled) await new Promise((resolve) => setTimeout(resolve, 1));
        yield { type: 'final', text: 'working', stopReason: 'cancelled' };
      }
    }
    const native = new SlowAdapter();
    const bridge = new AcpBridge({ id: 'native', kind: 'hermes' }, () => native);
    const address = await bridge.start({ port: 0, token: 'acp-test-token' });
    const adapter = new AcpAdapter('unified', {
      id: 'unified',
      kind: 'acp',
      transport: 'local',
      host: address.host,
      port: address.port,
      token: 'acp-test-token',
    });
    cleanups.push(async () => {
      await adapter.close();
      await bridge.close();
    });

    const events = [];
    for await (const event of adapter.prompt(undefined, 'wait')) {
      events.push(event);
      if (event.type === 'text' && event.text) await adapter.cancel(event.sessionId!);
    }
    expect(native.cancelled).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'final', stopReason: 'cancelled' });
  });

  it('connects to a standard ACP stdio agent through ndJsonStream', async () => {
    const adapter = new AcpAdapter('stdio', {
      id: 'stdio',
      kind: 'acp',
      transport: 'local',
      acpTransport: 'stdio',
      acpCommand: process.execPath,
      acpArgs: [fileURLToPath(new URL('./fixtures/acp-stdio-agent.mjs', import.meta.url))],
    });
    cleanups.push(() => adapter.close());
    expect(await adapter.health()).toMatchObject({ ok: true, protocol: 'acp', protocolVersion: 1 });
    const events = [];
    for await (const event of adapter.prompt(undefined, 'hello')) events.push(event);
    expect(events.at(-1)).toMatchObject({
      type: 'final',
      text: 'stdio:hello',
      stopReason: 'end_turn',
      sessionId: 'stdio-session',
    });

    // Uncached historical session fails honestly when server does not advertise loadSession
    const failed = [];
    for await (const event of adapter.prompt('unknown-historical-id', 'hello again')) failed.push(event);
    expect(failed.at(-1)).toMatchObject({ type: 'error' });
    expect(failed.at(-1)?.text).toMatch(/session\/load/);
  });

  it.each([
    {
      name: 'rejects an unsupported ACP protocol version',
      script: `const { id } = JSON.parse(line);
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: { protocolVersion: 2 } }) + '\\n');`,
      error: /Unsupported ACP protocol version 2/,
    },
    {
      name: 'reports a closed process without including subprocess stderr',
      script: "console.error('private-subprocess-output'); process.exit(42);",
      error: /^ACP connection closed$/,
    },
  ])('$name', async ({ script, error }) => {
    const adapter = new AcpAdapter('stdio-failure', {
      id: 'stdio-failure',
      kind: 'acp',
      transport: 'local',
      acpTransport: 'stdio',
      acpCommand: process.execPath,
      acpArgs: [
        '-e',
        `require('node:readline').createInterface({ input: process.stdin }).once('line', line => {
        ${script}
      });`,
      ],
    });
    cleanups.push(() => adapter.close());
    await expect(adapter.health()).rejects.toThrow(error);
  });

  it('paginates session/list via nextCursor to recover cwd for sessions on later pages', async () => {
    const { Readable, Writable } = await import('node:stream');
    const { agent, methods, ndJsonStream, PROTOCOL_VERSION } = await import('@agentclientprotocol/sdk');
    const { WebSocketServer } = await import('ws');
    const { AcpServer } = await import('@agentclientprotocol/sdk/experimental/server');
    const { createNodeWebSocketUpgradeHandler } = await import('@agentclientprotocol/sdk/experimental/node');
    const http = await import('node:http');
    void Readable;
    void Writable;
    void ndJsonStream;

    let resumedCwd: string | undefined;
    const acpServer = new AcpServer({
      createAgent: () => {
        const app = agent({ name: 'paged-agent' });
        app.onRequest(methods.agent.initialize, () => ({
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: { loadSession: false, sessionCapabilities: { list: {}, resume: {} } },
        }));
        app.onRequest(methods.agent.session.list, ({ params }) => {
          if (!params?.cursor) {
            return {
              sessions: [{ sessionId: 'page-1-sess', cwd: '/repo/page-1', title: 'Page 1' }],
              nextCursor: 'cursor-2',
            };
          }
          return {
            sessions: [{ sessionId: 'page-2-sess', cwd: '/repo/page-2', title: 'Page 2' }],
          };
        });
        app.onRequest(methods.agent.session.resume, ({ params }) => {
          resumedCwd = params.cwd;
          if (params.cwd !== '/repo/page-2') throw new Error(`unexpected cwd ${params.cwd}`);
          return {};
        });
        app.onRequest(methods.agent.session.prompt, async ({ params, client }) => {
          await client.notify(methods.client.session.update, {
            sessionId: params.sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'resumed-ok' } },
          });
          return { stopReason: 'end_turn' };
        });
        return app;
      },
    });
    const wss = new WebSocketServer({ noServer: true });
    const upgrade = createNodeWebSocketUpgradeHandler(acpServer, wss);
    const server = http.createServer((_req, res) => res.writeHead(404).end());
    server.on('upgrade', (req, socket, head) => upgrade(req, socket, head));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const adapter = new AcpAdapter('paged', { id: 'paged', kind: 'acp', transport: 'local', host: '127.0.0.1', port });
    cleanups.push(async () => {
      await adapter.close();
      for (const c of wss.clients) c.terminate();
      await acpServer.close();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    const events = [];
    for await (const event of adapter.prompt('page-2-sess', 'continue')) events.push(event);
    expect(resumedCwd).toBe('/repo/page-2');
    expect(events.at(-1)).toMatchObject({ type: 'final', text: 'resumed-ok', sessionId: 'page-2-sess' });
  });

  it('rejects overlapping prompts on the same ACP session without corrupting the active queue', async () => {
    class SlowAdapter extends FakeNativeAdapter {
      release!: () => void;
      override async *prompt(): AsyncIterable<AgentEvent> {
        yield { type: 'text', text: 'first-turn' };
        await new Promise<void>((resolve) => {
          this.release = resolve;
        });
        yield { type: 'final', text: 'first-turn', stopReason: 'completed' };
      }
    }
    const native = new SlowAdapter();
    const bridge = new AcpBridge({ id: 'native', kind: 'hermes' }, () => native);
    const address = await bridge.start({ port: 0, token: 'acp-test-token' });
    const adapter = new AcpAdapter('overlap', {
      id: 'overlap',
      kind: 'acp',
      transport: 'local',
      host: address.host,
      port: address.port,
      token: 'acp-test-token',
    });
    cleanups.push(async () => {
      await adapter.close();
      await bridge.close();
    });

    const firstEvents: AgentEvent[] = [];
    let activeSessionId = '';
    const firstTurn = (async () => {
      for await (const ev of adapter.prompt(undefined, 'turn 1')) {
        if (ev.sessionId) activeSessionId = ev.sessionId;
        firstEvents.push(ev);
      }
    })();
    while (!activeSessionId || !native.release) await new Promise((r) => setTimeout(r, 5));

    // Overlapping prompt on the same session is rejected and does NOT delete or poison turn 1's queue
    const overlapEvents: AgentEvent[] = [];
    for await (const ev of adapter.prompt(activeSessionId, 'turn 2')) overlapEvents.push(ev);
    expect(overlapEvents.at(-1)).toMatchObject({ type: 'error' });
    expect(overlapEvents.at(-1)?.text).toMatch(/already has an active prompt/);

    native.release();
    await firstTurn;
    expect(firstEvents.at(-1)).toMatchObject({ type: 'final', text: 'first-turn' });
  });

  it('keeps an ACP session busy after cancel() until the remote session/prompt returns its terminal response', async () => {
    const { AgentManager } = await import('../src/manager.js');
    let finishRemotePrompt!: () => void;
    class DelayedStopAdapter extends FakeNativeAdapter {
      override async *prompt(_sid: string | undefined, text: string): AsyncIterable<AgentEvent> {
        if (text === 'turn 1') {
          yield { type: 'text', text: 'working' };
          await new Promise<void>((resolve) => {
            finishRemotePrompt = resolve;
          });
          yield { type: 'final', text: 'working', stopReason: 'cancelled' };
          return;
        }
        yield { type: 'final', text: 'turn-2-done', stopReason: 'completed' };
      }
    }
    const native = new DelayedStopAdapter();
    const bridge = new AcpBridge({ id: 'native', kind: 'hermes' }, () => native);
    const address = await bridge.start({ port: 0, token: 'acp-test-token' });
    const cfg = {
      id: 'delayed',
      kind: 'acp' as const,
      transport: 'local' as const,
      host: address.host,
      port: address.port,
      token: 'acp-test-token',
    };
    const manager = new AgentManager([cfg], 10_000);
    cleanups.push(async () => {
      await manager.close();
      await bridge.close();
    });

    const first = manager.start('delayed', 'turn 1', undefined);
    while (!first.sessionId || !finishRemotePrompt) await new Promise((r) => setTimeout(r, 5));
    const sid = first.sessionId;

    await manager.cancel(first.id);
    await manager.wait(first.id);
    // Remote session/prompt has not returned its terminal response yet — turn 2 must still be rejected
    expect(() => manager.start('delayed', 'turn 2', sid)).toThrow(/active or cancelling job/);

    // Once the remote agent finishes turn 1, turn 2 is allowed
    finishRemotePrompt();
    await new Promise((r) => setTimeout(r, 25));
    const second = manager.start('delayed', 'turn 2', sid);
    const settled = await manager.wait(second.id);
    expect(settled.status).toBe('completed');
    expect(settled.text).toBe('turn-2-done');
  });
});
