import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as plugin from '../src/index.js';

import { apply, Config } from '../src/index.js';
import { AgentManager } from '../src/manager.js';
import { McpServer } from '../src/mcp/server.js';
import type { SessionControllerLike } from '../src/mcp/session-service.js';
import { loadStoredState } from '../src/store.js';
import type {
  AgentAdapter,
  AgentConfig,
  AgentEvent,
  AgentTimelineEntry,
  AgentToolActivity,
  AgentTranscriptMessage,
  SessionHistoryBaseline,
} from '../src/types.js';
import { registerWebRoutes, WEB_ROUTES } from '../src/web/routes.js';

class StubAdapter implements AgentAdapter {
  readonly kind = 'hermes' as const;
  responded?: string;
  cancelled = false;
  constructor(readonly id: string) {}
  async health() {
    return { ok: true };
  }
  async listSessions() {
    return [{ id: 'remote-1', title: 'Remote Task', updatedAt: '2026-11-20T00:00:00Z' }];
  }
  async getSessionMessages(sessionId: string): Promise<AgentTranscriptMessage[]> {
    return [{ id: 'message-1', role: 'assistant' as const, text: `${sessionId}: Bearer very-secret-value` }];
  }
  async *prompt(): AsyncIterable<AgentEvent> {
    yield { type: 'thought', text: 'Checking Bearer very-secret-value' };
    yield { type: 'approval', requestId: 'req-1', choices: ['approve', 'deny'], text: 'Run pytest?' };
    await new Promise((resolve) => setTimeout(resolve, 200));
    yield { type: 'final', text: 'done' };
  }
  async cancel() {
    this.cancelled = true;
  }
  async respond(_sessionId: string, _requestId: string, choice: string) {
    this.responded = choice;
  }
  async close() {}
}

const sessionsController: SessionControllerLike = {
  async list() {
    return { items: [{ sessionId: 'local-1', title: 'Local Session', cwd: '/work' }] };
  },
  async events() {
    return { records: [] };
  },
  async *follow() {},
};

let mcp: McpServer | undefined;
let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'dsh-knot-web-'));
  vi.stubEnv('DSH_KNOT_STATE_DIR', stateDir);
});
afterEach(async () => {
  await mcp?.close();
  mcp = undefined;
  vi.unstubAllEnvs();
  rmSync(stateDir, { recursive: true, force: true });
});

describe('web UI host routes & schemastery Config', () => {
  it('exports a valid schemastery Config schema', () => {
    expect(Config).toBeDefined();
    const parsed = Config({});
    expect(parsed.agents).toEqual([]);
    expect(parsed.jobTimeoutMs).toBe(1_800_000);
    expect(parsed.mcp?.enabled).toBe(false);
  });

  it('serves state, doctor, sessions, respond, cancel, and live mcp-share toggles', async () => {
    const config: AgentConfig = { id: 'hermes-local', kind: 'hermes', transport: 'local', port: 8642 };
    const adapter = new StubAdapter('hermes-local');
    const manager = new AgentManager([config], 10_000, () => adapter);
    mcp = new McpServer({ port: 0, token: 'secret-tok', allowSessions: [] }, sessionsController);
    await mcp.start();

    const routes = new Map<string, (req: Request) => Promise<Response>>();
    const ctx = {
      connection: {
        fetch: {
          register(route: { path: string; fetch: (req: Request) => Promise<Response> }) {
            routes.set(route.path, route.fetch);
            return () => routes.delete(route.path);
          },
        },
      },
      effect() {},
    } as any;

    registerWebRoutes(ctx, manager, mcp, sessionsController);
    expect([...routes.keys()].sort()).toEqual(Object.values(WEB_ROUTES).sort());

    const post = async (path: string, body: Record<string, unknown> = {}) => {
      const handler = routes.get(path)!;
      const res = await handler(
        new Request(`http://localhost${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
      return (await res.json()) as any;
    };

    const initial = await post(WEB_ROUTES.state);
    expect(initial.ok).toBe(true);
    expect(initial.value.agents).toHaveLength(1);
    expect(initial.value.agents[0].supportsSessionMessages).toBe(true);
    expect(initial.value.agents[0].connection.status).toBe('unverified');
    expect(initial.value.mcp.enabled).toBe(true);
    expect(initial.value.mcp.localSessions[0].shared).toBe(false);
    expect(JSON.stringify(initial)).not.toContain('secret-tok');

    const olderStop = {
      id: 'unconfirmed-stop',
      agentId: config.id,
      sessionId: 'remote-1',
      status: 'cancelled' as const,
      remoteStop: 'unconfirmed' as const,
      createdAt: 1,
      updatedAt: 1,
      text: '',
    };
    const jobList = vi.spyOn(manager, 'listJobs').mockReturnValue([
      ...Array.from({ length: 50 }, (_, index) => ({
        id: `recent-${index}`,
        agentId: config.id,
        status: 'completed' as const,
        createdAt: 2,
        updatedAt: 2,
        text: 'finished',
      })),
      olderStop,
    ]);
    try {
      const state = await post(WEB_ROUTES.state);
      expect(state.value.jobs).toHaveLength(50);
      expect(state.value.jobs[0]).toEqual(olderStop);
    } finally {
      jobList.mockRestore();
    }

    const toggled = await post(WEB_ROUTES.mcpShare, { sessionId: 'local-1', allow: true });
    expect(toggled.ok).toBe(true);
    expect(toggled.value.allowSessions).toEqual(['local-1']);

    const revision = initial.value.agents[0].revision;
    const remoteSessions = await post(WEB_ROUTES.sessions, { agentId: 'hermes-local', revision });
    expect(remoteSessions.ok).toBe(true);
    expect(remoteSessions.value.sessions[0].id).toBe('remote-1');
    const transcript = await post(WEB_ROUTES.sessionMessages, {
      agentId: 'hermes-local',
      revision,
      sessionId: 'remote-1',
    });
    expect(transcript).toEqual({
      ok: true,
      value: { messages: [{ id: 'message-1', role: 'assistant', text: 'remote-1: [REDACTED]' }] },
    });

    const doc = await post(WEB_ROUTES.doctor, { agent: 'hermes-local' });
    expect(doc.ok).toBe(true);
    expect(doc.value.agents[0].steps.every((s: any) => s.ok)).toBe(true);

    const afterDoc = await post(WEB_ROUTES.state);
    expect(afterDoc.value.agents[0].connection.status).toBe('connected');

    const submission = {
      agentId: 'hermes-local',
      revision,
      message: 'hello from panel',
      sessionId: 'remote-1',
      clientMessageId: 'submission-id-0001',
    };
    const [asked, replay] = await Promise.all([post(WEB_ROUTES.ask, submission), post(WEB_ROUTES.ask, submission)]);
    expect(asked.ok).toBe(true);
    expect(asked.value.prompt).toBe('hello from panel');
    expect(asked.value.sessionId).toBe('remote-1');
    expect(replay.value.id).toBe(asked.value.id);
    expect(manager.listJobs()).toHaveLength(1);
    expect(await post(WEB_ROUTES.ask, { ...submission, message: 'changed retry' })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/different conversation or gateway/),
    });
    expect(await post(WEB_ROUTES.job, { agentId: 'hermes-local', revision, jobId: asked.value.id })).toMatchObject({
      ok: true,
      value: { id: asked.value.id, sessionId: 'remote-1', thought: 'Checking [REDACTED]', text: '' },
    });
    const duplicate = await post(WEB_ROUTES.ask, {
      agentId: 'hermes-local',
      revision,
      message: 'overlapping turn',
      sessionId: 'remote-1',
    });
    expect(duplicate).toMatchObject({ ok: false, error: expect.stringMatching(/active or cancelling job/) });
    expect(() => manager.start('hermes-local', 'overlapping tool turn', 'remote-1')).toThrow(
      /active or cancelling job/,
    );
    await post(WEB_ROUTES.cancel, { jobId: asked.value.id });

    const job = manager.start('hermes-local', 'test', undefined);
    await new Promise((resolve) => setTimeout(resolve, 15));
    const stale = await post(WEB_ROUTES.respond, { jobId: job.id, requestId: 'stale-req', choice: 'approve' });
    expect(stale.ok).toBe(false);
    expect(stale.error).toMatch(/no longer pending/);

    const responded = await post(WEB_ROUTES.respond, { jobId: job.id, requestId: 'req-1', choice: 'approve' });
    expect(responded.ok).toBe(true);
    expect(adapter.responded).toBe('approve');

    const cancelled = await post(WEB_ROUTES.cancel, { jobId: job.id });
    expect(cancelled.ok).toBe(true);
    expect(cancelled.value.status).toBe('cancelled');

    const toggledPersisted = await post(WEB_ROUTES.mcpShare, { sessionId: 'local-1', allow: true });
    expect(toggledPersisted.ok).toBe(true);
    expect(loadStoredState().allowSessions).toEqual(['local-1']);

    const saved = await post(WEB_ROUTES.agentSave, {
      id: 'hermes-second',
      kind: 'hermes',
      transport: 'direct',
      host: '100.64.0.2',
      tls: true,
      token: 'per-agent-secret-token',
      acpArgs: ['--flag'],
    });
    expect(saved.ok).toBe(true);
    expect(saved.value.agents.map((a: any) => [a.id, a.hasToken, a.tls])).toContainEqual(['hermes-second', true, true]);
    expect(JSON.stringify(saved)).not.toContain('per-agent-secret-token');

    // Editing without changing token or advanced fields preserves both
    const edited = await post(WEB_ROUTES.agentSave, {
      id: 'hermes-second',
      kind: 'hermes',
      transport: 'direct',
      model: 'deepseek-chat',
    });
    expect(edited.ok).toBe(true);
    expect(manager.getConfig('hermes-second')?.token).toBe('per-agent-secret-token');
    expect(manager.getConfig('hermes-second')?.tls).toBe(true);
    expect(manager.getConfig('hermes-second')?.acpArgs).toEqual(['--flag']);

    vi.stubEnv('HERMES_API_KEY', 'ambient-secret');
    // Switching gateways clears the saved token and suppresses the ambient fallback.
    const cleared = await post(WEB_ROUTES.agentSave, {
      id: 'hermes-second',
      kind: 'hermes',
      transport: 'local',
    });
    expect(cleared.ok).toBe(true);
    expect(cleared.value.agents.find((agent: { id: string }) => agent.id === 'hermes-second')?.hasToken).toBe(false);
    expect(manager.getConfig('hermes-second')?.host).toBe('127.0.0.1');
    expect(manager.getConfig('hermes-second')?.tls).toBeUndefined();

    // Deleting an agent records a tombstone in deletedIds and aborts in-flight jobs
    const activeJob = manager.start('hermes-local', 'in-flight', undefined);
    const deleted = await post(WEB_ROUTES.agentDelete, { id: 'hermes-local' });
    expect(deleted.ok).toBe(true);
    expect(deleted.value.agents.map((a: any) => a.id)).not.toContain('hermes-local');
    expect(manager.get(activeJob.id).status).toBe('cancelled');
    expect(loadStoredState().deletedIds).toContain('hermes-local');

    // Concurrent saves preserve both agents without clobbering each other
    const [s1, s2] = await Promise.all([
      post(WEB_ROUTES.agentSave, { id: 'concurrent-a', kind: 'hermes', transport: 'local' }),
      post(WEB_ROUTES.agentSave, { id: 'concurrent-b', kind: 'hermes', transport: 'local' }),
    ]);
    expect(s1.ok).toBe(true);
    expect(s2.ok).toBe(true);
    const savedIds = loadStoredState().agents.map((a) => a.id);
    expect(savedIds).toContain('concurrent-a');
    expect(savedIds).toContain('concurrent-b');

    // An endpoint URL owns the port, including when switching from an older HTTP endpoint.
    const oldEndpoint = await post(WEB_ROUTES.agentSave, {
      id: 'aws-tailscale',
      kind: 'hermes',
      endpoint: 'http://aws-box.tail1234.ts.net:8642/legacy',
    });
    expect(oldEndpoint.ok).toBe(true);
    const tsSaved = await post(WEB_ROUTES.agentSave, {
      id: 'aws-tailscale',
      kind: 'hermes',
      transport: 'direct',
      endpoint: 'https://aws-box.tail1234.ts.net/hermes',
      port: 8642,
      token: 'ts-secret',
    });
    expect(tsSaved.ok).toBe(true);
    expect(manager.getConfig('aws-tailscale')).toMatchObject({
      host: 'aws-box.tail1234.ts.net',
      port: 443,
      tls: true,
      basePath: '/hermes',
    });

    const openclaw = await post(WEB_ROUTES.agentSave, {
      id: 'openclaw',
      kind: 'openclaw',
      endpoint: 'https://claw.tailnet.ts.net',
      token: 'claw-test-secret',
    });
    expect(openclaw.ok).toBe(true);
    const oldRevision = openclaw.value.agents.find((agent: { id: string }) => agent.id === 'openclaw').revision;
    const slash = await post(WEB_ROUTES.agentSave, { id: 'openclaw', endpoint: 'https://claw.tailnet.ts.net/' });
    expect(slash.ok).toBe(true);
    expect(manager.getConfig('openclaw')?.token).toBe('claw-test-secret');
    const staleSession = { agentId: 'openclaw', revision: oldRevision, sessionId: 'agent:main:main' };
    const [staleAsk, staleHistory, staleMessages] = await Promise.all([
      post(WEB_ROUTES.ask, { ...staleSession, message: 'stale turn' }),
      post(WEB_ROUTES.sessions, staleSession),
      post(WEB_ROUTES.sessionMessages, staleSession),
    ]);
    expect(staleAsk).toMatchObject({ ok: false, error: expect.stringMatching(/gateway configuration changed/) });
    expect(staleHistory).toMatchObject({ ok: false, error: expect.stringMatching(/gateway configuration changed/) });
    expect(staleMessages).toMatchObject({ ok: false, error: expect.stringMatching(/gateway configuration changed/) });

    // Deleted static agent stays deleted when plugin reloads
    const registeredTools: string[] = [];
    const effects: Array<() => Promise<void>> = [];
    await apply(
      {
        tools: { register: (t: { name: string }) => registeredTools.push(t.name) },
        effect: (fn: () => () => Promise<void>) => effects.push(fn()),
      } as any,
      { agents: [config] },
    );
    for (const cleanup of effects) await cleanup();

    const diskBlocked = join(stateDir, 'agents.json');
    vi.stubEnv('DSH_KNOT_STATE_DIR', diskBlocked);
    const failedSave = await post(WEB_ROUTES.agentSave, {
      id: 'aws-tailscale',
      endpoint: 'https://replacement.tailnet.ts.net',
    });
    const failedDelete = await post(WEB_ROUTES.agentDelete, { id: 'aws-tailscale' });
    expect(failedSave.ok).toBe(false);
    expect(failedDelete.ok).toBe(false);
    expect(manager.getConfig('aws-tailscale')?.host).toBe('aws-box.tail1234.ts.net');
    vi.stubEnv('DSH_KNOT_STATE_DIR', stateDir);

    // Corrupted agents.json throws instead of silently wiping state
    writeFileSync(join(stateDir, 'agents.json'), '{broken-json', 'utf8');
    expect(() => loadStoredState()).toThrow();

    await manager.close();
  });

  it('captures a fresh baseline for each admitted turn despite out-of-order history requests', async () => {
    let transcript: AgentTranscriptMessage[] = [];
    let holdNextRead = true;
    let releaseRead!: () => void;
    let startedRead!: () => void;
    const historyHeld = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const historyStarted = new Promise<void>((resolve) => {
      startedRead = resolve;
    });
    class HistoryAdapter extends StubAdapter {
      override async getSessionMessages() {
        const snapshot = transcript.slice();
        if (holdNextRead) {
          holdNextRead = false;
          startedRead();
          await historyHeld;
        }
        return snapshot;
      }
      override async *prompt(_sessionId?: string, prompt?: string): AsyncIterable<AgentEvent> {
        const turn = transcript.length / 2 + 1;
        transcript = [
          ...transcript,
          { id: `user-${turn}`, role: 'user', text: prompt ?? '' },
          { id: `assistant-${turn}`, role: 'assistant', text: 'done' },
        ];
        yield { type: 'final', text: 'done' };
      }
    }
    const config: AgentConfig = { id: 'history', kind: 'hermes', transport: 'local' };
    const manager = new AgentManager([config], 10_000, () => new HistoryAdapter(config.id));
    const routes = new Map<string, (req: Request) => Promise<Response>>();
    const ctx = {
      connection: {
        fetch: {
          register(route: { path: string; fetch: (req: Request) => Promise<Response> }) {
            routes.set(route.path, route.fetch);
            return () => routes.delete(route.path);
          },
        },
      },
      effect() {},
    } as any;
    registerWebRoutes(ctx, manager, undefined, undefined);
    const readHistory = () =>
      routes.get(WEB_ROUTES.sessionMessages)!(
        new Request('http://localhost/', {
          method: 'POST',
          body: JSON.stringify({ agentId: config.id, revision: manager.list()[0]?.revision, sessionId: 'remote' }),
        }),
      );

    const olderRead = readHistory();
    try {
      await historyStarted;
      const first = await manager.wait(manager.start(config.id, 'repeat', 'remote').id);
      expect(first.historyBaseline).toEqual({ length: 0 });
      expect((await readHistory()).ok).toBe(true);
      releaseRead();
      await expect(olderRead.then((response) => response.json())).resolves.toMatchObject({
        value: { messages: [] },
      });

      const second = await manager.wait(manager.start(config.id, 'repeat', 'remote').id);
      expect(second.historyBaseline).toEqual({ length: 2, lastId: 'assistant-1' });
      const third = await manager.wait(manager.start(config.id, 'repeat', 'remote').id);
      expect(third.historyBaseline).toEqual({ length: 4, lastId: 'assistant-2' });
    } finally {
      releaseRead();
      await manager.close();
    }
  });

  it('cancels a pending history read before submitting or stopping a remote run', async () => {
    let releaseHistory!: (transcript: AgentTranscriptMessage[]) => void;
    const history = new Promise<AgentTranscriptMessage[]>((resolve) => {
      releaseHistory = resolve;
    });
    const config: AgentConfig = { id: 'history', kind: 'hermes', transport: 'local' };
    const adapter = new StubAdapter(config.id);
    vi.spyOn(adapter, 'getSessionMessages').mockReturnValue(history);
    const prompt = vi.spyOn(adapter, 'prompt');
    const manager = new AgentManager([config], 10_000, () => adapter);
    try {
      const job = manager.start(config.id, 'new turn', 'remote');
      expect(job.status).toBe('queued');
      expect((await manager.cancel(job.id)).status).toBe('cancelled');
      expect((await manager.wait(job.id)).historyBaseline).toBeUndefined();
      expect(prompt).not.toHaveBeenCalled();
      expect(adapter.cancelled).toBe(false);
    } finally {
      releaseHistory([]);
      await manager.close();
    }
  });

  it('admits overlapping turns in order without attaching ambiguous history evidence', async () => {
    let releaseHistory!: () => void;
    const historyHeld = new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });
    const prompts: string[] = [];
    class ConcurrentAdapter extends StubAdapter {
      override async getSessionMessages(sessionId: string) {
        await historyHeld;
        return super.getSessionMessages(sessionId);
      }
      override async *prompt(_sessionId?: string, prompt?: string): AsyncIterable<AgentEvent> {
        prompts.push(prompt ?? '');
        yield { type: 'final', text: 'done' };
      }
    }
    const config: AgentConfig = { id: 'history', kind: 'hermes', transport: 'local' };
    const adapter = new ConcurrentAdapter(config.id);
    const manager = new AgentManager([config], 10_000, () => adapter);
    try {
      const first = manager.start(config.id, 'first', 'remote');
      const waiting = manager.start(config.id, 'cancelled', 'remote');
      expect((await manager.cancel(waiting.id)).status).toBe('cancelled');
      expect(adapter.cancelled).toBe(false);
      const second = manager.start(config.id, 'second', 'remote');
      const third = manager.start(config.id, 'third', 'remote');
      expect(prompts).toEqual([]);
      releaseHistory();
      const settled = await Promise.all([manager.wait(first.id), manager.wait(second.id), manager.wait(third.id)]);
      expect(prompts).toEqual(['first', 'second', 'third']);
      expect(settled.every((job) => job.status === 'completed' && job.historyBaseline === undefined)).toBe(true);
    } finally {
      releaseHistory();
      await manager.close();
    }
  });

  it('keeps remote cancellation ownership when a newer preparation is cancelled locally', async () => {
    let releaseHistory!: () => void;
    const historyHeld = new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });
    let enterPrompt!: () => void;
    let releasePrompt!: () => void;
    const promptStarted = new Promise<void>((resolve) => {
      enterPrompt = resolve;
    });
    const promptHeld = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    class ConcurrentAdapter extends StubAdapter {
      override async getSessionMessages(sessionId: string) {
        await historyHeld;
        return super.getSessionMessages(sessionId);
      }
      override async *prompt(): AsyncIterable<AgentEvent> {
        enterPrompt();
        await promptHeld;
        yield { type: 'final', stopReason: 'cancelled' };
      }
    }
    const config: AgentConfig = { id: 'history', kind: 'hermes', transport: 'local' };
    const adapter = new ConcurrentAdapter(config.id);
    const manager = new AgentManager([config], 10_000, () => adapter);
    try {
      const first = manager.start(config.id, 'first', 'remote');
      const second = manager.start(config.id, 'second', 'remote');
      expect((await manager.cancel(second.id)).status).toBe('cancelled');
      expect(adapter.cancelled).toBe(false);
      releaseHistory();
      await promptStarted;

      expect((await manager.cancel(first.id)).status).toBe('cancelled');
      expect(adapter.cancelled).toBe(true);
      releasePrompt();
      await Promise.all([manager.wait(first.id), manager.wait(second.id)]);
    } finally {
      releaseHistory();
      releasePrompt();
      await manager.close();
    }
  });

  it('bounds hanging sessions requests and records failedStep on doctor errors', async () => {
    const hangingAdapter: AgentAdapter = {
      id: 'slow-hermes',
      kind: 'hermes',
      async health() {
        throw new Error('socket hang up');
      },
      async listSessions(signal) {
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('sessions timed out')), { once: true });
        });
      },
      async *prompt() {},
      async cancel() {},
      async close() {},
    };
    const manager = new AgentManager(
      [{ id: 'slow-hermes', kind: 'hermes', transport: 'local', port: 8642, connectTimeoutMs: 120 }],
      10_000,
      () => hangingAdapter,
    );
    const routes = new Map<string, (req: Request) => Promise<Response>>();
    registerWebRoutes(
      {
        connection: {
          fetch: {
            register(route: { path: string; fetch: (req: Request) => Promise<Response> }) {
              routes.set(route.path, route.fetch);
              return () => routes.delete(route.path);
            },
          },
        },
        effect() {},
      } as any,
      manager,
      undefined,
      undefined,
    );
    const post = async (path: string, body: Record<string, unknown> = {}) => {
      const res = await routes.get(path)!(
        new Request(`http://localhost${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
      return (await res.json()) as any;
    };

    const sessionsRes = await post(WEB_ROUTES.sessions, {
      agentId: 'slow-hermes',
      revision: manager.list()[0]?.revision,
    });
    expect(sessionsRes.ok).toBe(false);
    expect(sessionsRes.error).toMatch(/timed out/i);

    const docRes = await post(WEB_ROUTES.doctor, { agent: 'slow-hermes' });
    expect(docRes.ok).toBe(true);
    const stateRes = await post(WEB_ROUTES.state);
    expect(stateRes.value.agents[0].connection).toMatchObject({
      status: 'error',
      failedStep: 'gateway-health',
    });
    expect(stateRes.value.agents[0].connection.error).toContain('socket hang up');

    await manager.close();
  });

  it('activates cleanly in real Cordis 4.1.0 without sessionController, mounts routes on connection, and gates agent_respond with ask', async () => {
    const root = new Context();
    const registeredTools: string[] = [];
    const registeredRoutes: string[] = [];
    (root as any).provide('tools');
    (root as any).set('tools', { register: (tool: { name: string }) => registeredTools.push(tool.name) });

    // Default config without sessionController must activate without throwing
    const fiber = root.plugin(plugin as any, {});
    await fiber;
    expect(registeredTools).toHaveLength(7);

    // Providing connection later mounts the Dashboard routes on the injected child context.
    (root as any).provide('connection');
    (root as any).set('connection', {
      fetch: {
        register(route: { path: string }) {
          registeredRoutes.push(route.path);
          return () => {};
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(registeredRoutes.sort()).toEqual(Object.values(WEB_ROUTES).sort());

    // tools/pre-execute forces user confirmation ('ask') for agent_respond bound to request_id
    const decision = await (root as any).waterfall(
      'tools/pre-execute',
      { name: 'agent_respond', arguments: { job: 'job-1', request_id: 'req-1', choice: 'approve' } },
      async () => ({ kind: 'allow' }),
    );
    expect(decision).toMatchObject({ kind: 'ask' });
    expect(decision.reason).toContain('req-1');

    const passthrough = await (root as any).waterfall(
      'tools/pre-execute',
      { name: 'agent_list', arguments: {} },
      async () => ({ kind: 'allow' }),
    );
    expect(passthrough).toEqual({ kind: 'allow' });

    await fiber.dispose();
  });

  it('activates the client entry in real Cordis 4.1.0 without locale injected and mounts main + sidebar slots', async () => {
    const clientPlugin = await import('../src/client/index.js');
    const mod = createRequire(import.meta.url)('node:module') as {
      _load: (req: string, parent: unknown, isMain: boolean) => unknown;
    };
    const origLoad = mod._load;
    mod._load = (req, parent, isMain) => {
      if (req === 'react') {
        return {
          createElement: () => null,
          useState: (v: unknown) => [v, () => {}],
          useEffect: () => {},
          useCallback: (fn: unknown) => fn,
          useRef: (v: unknown) => ({ current: v }),
        };
      }
      if (req === '@deepseek-ai/dsh-client-ui-primitives') {
        const render = () => null;
        return { Button: render, CommandText: render, MarkdownText: render, UserMessageBubble: render };
      }
      return origLoad(req, parent, isMain);
    };
    try {
      const root = new Context();
      const mountedSlots: string[] = [];
      (root as any).provide('slots');
      (root as any).set('slots', {
        inject(name: string, factory: () => () => void) {
          mountedSlots.push(name);
          return factory();
        },
        register() {
          return () => {};
        },
      });
      const fiber = root.plugin(clientPlugin as any, {});
      await fiber;
      expect(mountedSlots.sort()).toEqual(['main', 'sidebar.panellist']);
      await fiber.dispose();
    } finally {
      mod._load = origLoad;
    }
  });

  it('keeps live running turn activity visible when session history still ends at a previous turn', async () => {
    const clientPlugin = await import('../src/client/index.js');
    const mod = createRequire(import.meta.url)('node:module') as {
      _load: (req: string, parent: unknown, isMain: boolean) => unknown;
    };
    const origLoad = mod._load;

    interface VNode {
      type: unknown;
      props: Record<string, unknown>;
      children: unknown[];
    }
    const hooksByPath = new Map<string, unknown[]>();
    let currentPath = '';
    let hookIndex = 0;
    const pendingEffects: Array<() => void> = [];
    const cleanups: Array<() => void> = [];
    const fakeReact = {
      createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): VNode {
        return {
          type,
          props: props ?? {},
          children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== true),
        };
      },
      useState<T>(init: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void] {
        const list = hooksByPath.get(currentPath) ?? [];
        if (!hooksByPath.has(currentPath)) hooksByPath.set(currentPath, list);
        const idx = hookIndex++;
        if (list.length <= idx) list[idx] = typeof init === 'function' ? (init as () => T)() : init;
        const path = currentPath;
        return [
          list[idx] as T,
          (next) => {
            const target = hooksByPath.get(path)!;
            target[idx] = typeof next === 'function' ? (next as (prev: T) => T)(target[idx] as T) : next;
          },
        ];
      },
      useRef<T>(init: T) {
        const list = hooksByPath.get(currentPath) ?? [];
        if (!hooksByPath.has(currentPath)) hooksByPath.set(currentPath, list);
        const idx = hookIndex++;
        if (list.length <= idx) list[idx] = { current: init };
        return list[idx] as { current: T };
      },
      useCallback<T>(fn: T): T {
        return fn;
      },
      useEffect(fn: () => undefined | (() => void), deps?: readonly unknown[]) {
        const list = hooksByPath.get(currentPath) ?? [];
        if (!hooksByPath.has(currentPath)) hooksByPath.set(currentPath, list);
        const idx = hookIndex++;
        const prev = list[idx] as { deps: readonly unknown[] | null; cleanup?: () => void } | undefined;
        const changed = !prev || !deps || !prev.deps || deps.some((d, i) => !Object.is(d, prev.deps![i]));
        if (changed) {
          if (prev?.cleanup) prev.cleanup();
          const slot: { deps: readonly unknown[] | null; cleanup?: () => void } = {
            deps: deps ? [...deps] : null,
          };
          list[idx] = slot;
          pendingEffects.push(() => {
            const cleanup = fn();
            if (typeof cleanup === 'function') {
              slot.cleanup = cleanup;
              cleanups.push(cleanup);
            }
          });
        }
      },
    };
    const renderNode = (node: unknown, path = 'root'): unknown => {
      if (node === null || node === undefined || typeof node !== 'object') return node;
      const vnode = node as VNode;
      if (typeof vnode.type === 'function') {
        const prevPath = currentPath;
        const prevIdx = hookIndex;
        const key = vnode.props.key !== undefined ? `:${String(vnode.props.key)}` : '';
        currentPath = `${path}/${vnode.type.name || 'fn'}${key}`;
        hookIndex = 0;
        const out = (vnode.type as (p: Record<string, unknown>) => unknown)({
          ...vnode.props,
          children: vnode.children,
        });
        const rendered = renderNode(out, currentPath);
        currentPath = prevPath;
        hookIndex = prevIdx;
        return rendered;
      }
      return {
        ...vnode,
        children: vnode.children.map((child, i) => renderNode(child, `${path}.${i}`)),
      };
    };
    const collectText = (node: unknown): string[] => {
      if (typeof node === 'string' || typeof node === 'number') return [String(node)];
      if (!node || typeof node !== 'object') return [];
      const vnode = node as VNode;
      const own = typeof vnode.props?.text === 'string' ? [vnode.props.text] : [];
      return [...own, ...vnode.children.flatMap(collectText)];
    };
    const findButton = (node: unknown, label: string): VNode | undefined => {
      if (!node || typeof node !== 'object') return undefined;
      const vnode = node as VNode;
      if (vnode.type === 'button' && collectText(vnode).join('').includes(label)) return vnode;
      for (const child of vnode.children) {
        const found = findButton(child, label);
        if (found) return found;
      }
      return undefined;
    };

    let currentJob: {
      id: string;
      agentId: string;
      sessionId: string;
      prompt: string;
      status: string;
      createdAt: number;
      updatedAt: number;
      text: string;
      thought?: string;
      error?: string;
      tools?: AgentToolActivity[];
      timeline?: AgentTimelineEntry[];
      historyBaseline?: SessionHistoryBaseline;
    } = {
      id: 'job-2',
      agentId: 'hermes-remote',
      sessionId: 'sess-1',
      prompt: 'current prompt',
      status: 'running',
      createdAt: 2000,
      updatedAt: 2000,
      text: '',
      historyBaseline: { length: 2, lastId: 'm2' },
      thought: 'live turn thought',
      tools: [{ id: 't-live', name: 'terminal', status: 'running', inputPreview: 'ls -la' }],
      timeline: [
        { kind: 'thought', text: 'live turn thought' },
        { kind: 'commentary', text: 'Checking live state...' },
        { kind: 'tool', toolId: 't-live' },
      ],
    };
    let historyMessages: AgentTranscriptMessage[] = [
      { id: 'm1', role: 'user', text: 'previous prompt' },
      {
        id: 'm2',
        role: 'assistant',
        text: 'previous reply',
        thought: 'previous turn thought',
        tools: [{ id: 't-old', name: 'terminal', status: 'completed', inputPreview: 'pwd' }],
      },
    ];

    mod._load = (req, parent, isMain) => {
      if (req === 'react') return fakeReact;
      if (req === '@deepseek-ai/dsh-client-ui-primitives') {
        const passthrough = (props: Record<string, unknown>) =>
          fakeReact.createElement('div', props, ...(Array.isArray(props.children) ? props.children : []));
        return {
          Button: passthrough,
          CommandText: passthrough,
          MarkdownText: passthrough,
          UserMessageBubble: passthrough,
        };
      }
      return origLoad(req, parent, isMain);
    };

    try {
      let renderMain: (() => unknown) | undefined;
      const root = new Context();
      (root as any).provide('slots');
      (root as any).provide('connection');
      (root as any).set('connection', {
        async fetch(path: string) {
          const ok = (value: unknown) => ({ ok: true, status: 200, json: async () => ({ ok: true, value }) });
          if (path === WEB_ROUTES.state) {
            return ok({
              version: '0.2.1',
              agents: [
                {
                  id: 'hermes-remote',
                  revision: 'rev-1',
                  kind: 'hermes',
                  transport: 'direct',
                  host: '127.0.0.1',
                  port: 8642,
                  supportsRespond: true,
                  supportsSessionMessages: true,
                  connection: { status: 'connected' },
                },
              ],
              jobs: [currentJob],
              mcp: { enabled: false, address: null, allowSessions: [], localSessions: [] },
            });
          }
          if (path === WEB_ROUTES.sessions) {
            return ok({
              sessions: [
                { id: 'sess-1', title: 'Live session' },
                { id: 'sess-2', title: 'Live session 2' },
                { id: 'sess-3', title: 'Live session 3' },
                { id: 'sess-4', title: 'Live session 4' },
                { id: 'sess-5', title: 'Live session 5' },
              ],
            });
          }
          if (path === WEB_ROUTES.sessionMessages) return ok({ messages: historyMessages });
          if (path === WEB_ROUTES.job) return ok(currentJob);
          return ok({});
        },
      });
      (root as any).set('slots', {
        inject(_name: string, factory: () => () => void) {
          return factory();
        },
        register(meta: Record<string, unknown>, render: () => unknown) {
          if (meta.name === 'main') renderMain = render;
          return () => {};
        },
      });
      const fiber = root.plugin(clientPlugin as any, {});
      await fiber;
      const flush = async () => {
        for (let step = 0; step < 6; step++) {
          const tree = renderNode(renderMain!());
          while (pendingEffects.length > 0) pendingEffects.shift()!();
          await new Promise((r) => setTimeout(r, 0));
          if (step === 5) return tree;
        }
        return renderNode(renderMain!());
      };

      // Case A: While the job is running and history still ends on the previous turn,
      // live activity (prompt, thought, commentary, tool) stays visible.
      const dashboard = await flush();
      const chatBtn = findButton(dashboard, '对话');
      expect(chatBtn).toBeDefined();
      (chatBtn!.props.onClick as () => void)();
      const opened = await flush();
      const sessionBtn = findButton(opened, 'Live session');
      expect(sessionBtn).toBeDefined();
      (sessionBtn!.props.onClick as () => void)();
      const liveTree = await flush();
      const liveText = collectText(liveTree).join('\n');
      expect(liveText).toContain('previous turn thought');
      expect(liveText).toContain('current prompt');
      expect(liveText).toContain('live turn thought');
      expect(liveText).toContain('Checking live state...');
      expect(liveText).toContain('ls -la');

      // Case B: If the job settles with the SAME prompt, reply, AND reused tool-call ID as the previous
      // turn while history row IDs are still unchanged (m1/m2), do NOT hide the newly completed turn!
      const reusedToolId = 'r'.repeat(64);
      historyMessages = [
        { id: 'm1', role: 'user', text: 'previous prompt' },
        {
          id: 'm2',
          role: 'assistant',
          text: 'previous reply',
          thought: 'previous turn thought',
          tools: [{ id: reusedToolId, name: 'terminal', status: 'completed', inputPreview: 'pwd' }],
        },
      ];
      currentJob = {
        ...currentJob,
        prompt: 'previous prompt',
        status: 'completed',
        updatedAt: 3000,
        text: 'previous reply',
        thought: 'second run thought',
        tools: [{ id: reusedToolId, name: 'terminal', status: 'completed', inputPreview: 'whoami' }],
        timeline: [
          { kind: 'thought', text: 'second run thought' },
          { kind: 'tool', toolId: reusedToolId },
          { kind: 'text', text: 'previous reply' },
        ],
      };
      // Trigger poll update in-place by waiting past the 400ms poll interval
      await new Promise((r) => setTimeout(r, 450));
      const unchangedHistoryTree = await flush();
      const unchangedTexts = collectText(unchangedHistoryTree);
      expect(unchangedTexts.filter((t) => t === 'previous prompt')).toHaveLength(2);
      expect(unchangedTexts.filter((t) => t === 'previous reply')).toHaveLength(2);
      expect(unchangedTexts).toContain('second run thought');
      expect(unchangedTexts).toContain('whoami');

      // Case C: Open 'sess-2' with a running job containing two same-name `terminal` calls (A and B),
      // partial live thought, missing live preview on B, and prose + tool B; when history advances to m3/m4
      // with fuller thought, persisted-only prose & tool, and persisted preview on B, verify exact merged
      // order, fuller thought, filled preview, zero duplicate tools, and preserved earlier distinct prose.
      const toolAId = 'a'.repeat(64);
      const toolBId = 'b'.repeat(64);
      const toolPersistedOnlyId = 'p'.repeat(64);
      currentJob = {
        id: 'job-3',
        agentId: 'hermes-remote',
        sessionId: 'sess-2',
        prompt: 'current prompt',
        status: 'running',
        createdAt: 4000,
        updatedAt: 4000,
        text: '',
        historyBaseline: { length: 2, lastId: 'm2' },
        thought: 'Check the status',
        tools: [{ id: toolAId, name: 'terminal', status: 'running', inputPreview: 'cmd-A' }],
        timeline: [
          { kind: 'thought', text: 'Check the status' },
          { kind: 'commentary', text: 'Checking live state...' },
          { kind: 'tool', toolId: toolAId },
        ],
      };
      historyMessages = [
        { id: 'm1', role: 'user', text: 'older prompt' },
        { id: 'm2', role: 'assistant', text: 'older reply' },
      ];
      // Switch to sess-2 while job-3 is running (captures baseline m1/m2)
      const backBtn = findButton(unchangedHistoryTree, '助手设置');
      expect(backBtn).toBeDefined();
      (backBtn!.props.onClick as () => void)();
      const backDash = await flush();
      (findButton(backDash, '对话')!.props.onClick as () => void)();
      const reopened = await flush();
      const session2Btn = findButton(reopened, 'Live session 2');
      expect(session2Btn).toBeDefined();
      (session2Btn!.props.onClick as () => void)();
      await flush();

      // job-3 completes: live has partial thought, commentary, tool A, prose 'Working...', tool B (NO live preview),
      // and 'final answer'. Persisted history has fuller thought, distinct prose containing 'final answer',
      // persisted-only tool P, prose 'Working...' + tool B (WITH persisted preview), and 'final answer'.
      currentJob = {
        ...currentJob,
        status: 'completed',
        updatedAt: 5000,
        text: 'Working...final answer',
        tools: [
          { id: toolAId, name: 'terminal', status: 'completed', inputPreview: 'cmd-A' },
          { id: toolBId, name: 'terminal', status: 'completed' },
        ],
        timeline: [
          { kind: 'thought', text: 'Check the status' },
          { kind: 'commentary', text: 'Checking live state...' },
          { kind: 'tool', toolId: toolAId },
          { kind: 'text', text: 'Working...' },
          { kind: 'tool', toolId: toolBId },
          { kind: 'text', text: 'final answer' },
        ],
      };
      historyMessages = [
        ...historyMessages,
        { id: 'm3', role: 'user', text: 'current prompt' },
        {
          id: 'm4',
          role: 'assistant',
          thought: 'Check the status, then investigate the failed process',
          text: 'The final answer depends on README.',
          tools: [{ id: toolPersistedOnlyId, name: 'terminal', status: 'completed', inputPreview: 'cmd-P' }],
        },
        {
          id: 'm5',
          role: 'assistant',
          text: 'Working...',
          tools: [{ id: toolBId, name: 'terminal', status: 'completed', inputPreview: 'cmd-B-persisted' }],
        },
        {
          id: 'm6',
          role: 'assistant',
          text: 'final answer',
        },
      ];
      await new Promise((r) => setTimeout(r, 450));
      const settledTree = await flush();
      const settledTexts = collectText(settledTree);
      expect(settledTexts.filter((t) => t === 'current prompt')).toHaveLength(1);
      expect(settledTexts.filter((t) => t === 'final answer')).toHaveLength(1);
      expect(settledTexts.filter((t) => t === 'Working...')).toHaveLength(1);
      expect(settledTexts.filter((t) => t === 'cmd-A')).toHaveLength(1);
      expect(settledTexts.filter((t) => t === 'cmd-B-persisted')).toHaveLength(1);
      expect(settledTexts.filter((t) => t === 'cmd-P')).toHaveLength(1);
      expect(settledTexts.filter((t) => t === 'Checking live state...')).toHaveLength(1);
      // Fuller persisted thought replaces shorter live prefix; distinct prose containing 'final answer' is preserved
      expect(settledTexts).toContain('Check the status, then investigate the failed process');
      expect(settledTexts).not.toContain('Check the status');
      expect(settledTexts).toContain('The final answer depends on README.');
      // Assert strict chronological order across persisted-only and live-only items
      const idxThought = settledTexts.indexOf('Check the status, then investigate the failed process');
      const idxDistinctProse = settledTexts.indexOf('The final answer depends on README.');
      const idxCmdP = settledTexts.indexOf('cmd-P');
      const idxCommentary = settledTexts.indexOf('Checking live state...');
      const idxCmdA = settledTexts.indexOf('cmd-A');
      const idxWorking = settledTexts.indexOf('Working...');
      const idxCmdB = settledTexts.indexOf('cmd-B-persisted');
      const idxFinal = settledTexts.indexOf('final answer');
      expect(idxThought).toBeGreaterThan(-1);
      expect(idxThought).toBeLessThan(idxDistinctProse);
      expect(idxDistinctProse).toBeLessThan(idxCmdP);
      expect(idxCmdP).toBeLessThan(idxWorking);
      expect(idxCommentary).toBeLessThan(idxCmdA);
      expect(idxCmdA).toBeLessThan(idxWorking);
      expect(idxWorking).toBeLessThan(idxCmdB);
      expect(idxCmdB).toBeLessThan(idxFinal);

      // Case D1: Both history reads can include the fast job. Only its server-side pre-run baseline is authoritative.
      const stalledResolvers = new Map<string, () => void>();
      const sessionFetchCounts = new Map<string, number>();
      const firstFetchMessages = new Map<string, AgentTranscriptMessage[] | 'fail'>([
        [
          'sess-3',
          [
            { id: 'f1', role: 'user', text: 'fast prompt' },
            { id: 'f2', role: 'assistant', text: 'fast reply' },
          ],
        ],
        [
          'sess-4',
          [
            { id: 'older1', role: 'user', text: 'older prompt' },
            { id: 'older2', role: 'assistant', text: 'older reply' },
          ],
        ],
        ['sess-5', 'fail'],
      ]);
      const origFetch = (root as any).get('connection').fetch;
      (root as any).get('connection').fetch = async (path: string, init?: RequestInit) => {
        if (path === WEB_ROUTES.sessionMessages && firstFetchMessages.has(currentJob.sessionId)) {
          const sid = currentJob.sessionId;
          const count = (sessionFetchCounts.get(sid) ?? 0) + 1;
          sessionFetchCounts.set(sid, count);
          if (count === 1) {
            await new Promise<void>((resolve) => {
              stalledResolvers.set(sid, resolve);
              init?.signal?.addEventListener('abort', () => resolve(), { once: true });
            });
            const scripted = firstFetchMessages.get(sid)!;
            if (scripted === 'fail') {
              return { ok: false, status: 500, json: async () => ({ ok: false, error: 'temporary history error' }) };
            }
            return { ok: true, status: 200, json: async () => ({ ok: true, value: { messages: scripted } }) };
          }
        }
        return origFetch(path, init);
      };
      currentJob = {
        id: 'job-4',
        agentId: 'hermes-remote',
        sessionId: 'sess-3',
        prompt: 'fast prompt',
        status: 'running',
        createdAt: 6000,
        updatedAt: 6000,
        text: '',
        timeline: [],
        historyBaseline: { length: 0 },
      };
      historyMessages = [
        { id: 'f1', role: 'user', text: 'fast prompt' },
        { id: 'f2', role: 'assistant', text: 'fast reply' },
      ];
      (findButton(settledTree, '助手设置')!.props.onClick as () => void)();
      const dash3 = await flush();
      (findButton(dash3, '对话')!.props.onClick as () => void)();
      const reopened3 = await flush();
      (findButton(reopened3, 'Live session 3')!.props.onClick as () => void)();
      // The adapter can already persist this turn while the last job poll still reports "running".
      renderNode(renderMain!());
      while (pendingEffects.length > 0) pendingEffects.shift()!();
      stalledResolvers.get('sess-3')?.();
      await flush();
      currentJob = {
        ...currentJob,
        status: 'completed',
        updatedAt: 7000,
        text: 'fast reply',
        timeline: [{ kind: 'text', text: 'fast reply' }],
      };
      await new Promise((r) => setTimeout(r, 450));
      const fastFreshTree = await flush();
      const fastFreshTexts = collectText(fastFreshTree);
      expect(sessionFetchCounts.get('sess-3')).toBeGreaterThanOrEqual(2);
      expect(fastFreshTexts.filter((t) => t === 'fast prompt')).toHaveLength(1);
      expect(fastFreshTexts.filter((t) => t === 'fast reply')).toHaveLength(1);

      // Case D2: History reads spanning an intervening turn cannot substitute for a missing pre-run baseline.
      currentJob = {
        id: 'job-5',
        agentId: 'hermes-remote',
        sessionId: 'sess-4',
        prompt: 'fast prompt',
        status: 'running',
        createdAt: 8000,
        updatedAt: 8000,
        text: '',
        timeline: [],
      };
      historyMessages = [
        { id: 'old1', role: 'user', text: 'fast prompt' },
        { id: 'old2', role: 'assistant', text: 'fast reply' },
      ];
      (findButton(fastFreshTree, '助手设置')!.props.onClick as () => void)();
      const dash4 = await flush();
      (findButton(dash4, '对话')!.props.onClick as () => void)();
      const reopened4 = await flush();
      (findButton(reopened4, 'Live session 4')!.props.onClick as () => void)();
      renderNode(renderMain!());
      while (pendingEffects.length > 0) pendingEffects.shift()!();
      currentJob = {
        ...currentJob,
        status: 'completed',
        updatedAt: 9000,
        text: 'fast reply',
        timeline: [{ kind: 'text', text: 'fast reply' }],
      };
      await new Promise((r) => setTimeout(r, 450));
      stalledResolvers.get('sess-4')?.();
      const fastStaleTree = await flush();
      const fastStaleTexts = collectText(fastStaleTree);
      expect(sessionFetchCounts.get('sess-4')).toBeGreaterThanOrEqual(2);
      expect(fastStaleTexts.filter((t) => t === 'fast prompt')).toHaveLength(2);
      expect(fastStaleTexts.filter((t) => t === 'fast reply')).toHaveLength(2);

      // Case D3 (Failed run with same prompt and no reply, unbaselined because Fetch 1 failed):
      // must NOT attach the previous successful answer `[old1, old2]` to the failed run.
      currentJob = {
        id: 'job-6',
        agentId: 'hermes-remote',
        sessionId: 'sess-5',
        prompt: 'fast prompt',
        status: 'running',
        createdAt: 10_000,
        updatedAt: 10_000,
        text: '',
        timeline: [],
      };
      historyMessages = [
        { id: 'old1', role: 'user', text: 'fast prompt' },
        { id: 'old2', role: 'assistant', text: 'fast reply' },
      ];
      (findButton(fastStaleTree, '助手设置')!.props.onClick as () => void)();
      const dash5 = await flush();
      (findButton(dash5, '对话')!.props.onClick as () => void)();
      const reopened5 = await flush();
      (findButton(reopened5, 'Live session 5')!.props.onClick as () => void)();
      renderNode(renderMain!());
      while (pendingEffects.length > 0) pendingEffects.shift()!();
      currentJob = {
        ...currentJob,
        status: 'failed',
        updatedAt: 11_000,
        text: '',
        error: 'Gateway error',
        timeline: [],
      };
      await new Promise((r) => setTimeout(r, 450));
      stalledResolvers.get('sess-5')?.();
      const failedRunTree = await flush();
      const failedRunTexts = collectText(failedRunTree);
      expect(failedRunTexts.filter((t) => t === 'fast prompt')).toHaveLength(2);
      expect(failedRunTexts.filter((t) => t === 'fast reply')).toHaveLength(1);
      expect(failedRunTexts.join('\n')).toContain('Gateway error');

      for (const cleanup of cleanups) cleanup();
      await fiber.dispose();
    } finally {
      mod._load = origLoad;
    }
  });
});
