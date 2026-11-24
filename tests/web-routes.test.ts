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
import type { AgentAdapter, AgentConfig, AgentEvent } from '../src/types.js';
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
  async getSessionMessages(sessionId: string) {
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

    let currentJob = {
      id: 'job-2',
      agentId: 'hermes-remote',
      sessionId: 'sess-1',
      prompt: 'current prompt',
      status: 'running',
      createdAt: 2000,
      updatedAt: 2000,
      text: '',
      thought: 'live turn thought',
      tools: [{ id: 't-live', name: 'terminal', status: 'running', inputPreview: 'ls -la' }],
      timeline: [
        { kind: 'thought', text: 'live turn thought' },
        { kind: 'commentary', text: 'Checking live state...' },
        { kind: 'tool', toolId: 't-live' },
      ],
    };
    let historyMessages = [
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
          if (path === WEB_ROUTES.sessions) return ok({ sessions: [{ id: 'sess-1', title: 'Live session' }] });
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

      // Once the job completes and history persists only the final reply + 1st tool (not the commentary or 2nd tool),
      // already-persisted segments are not duplicated while unpersisted live segments remain visible.
      currentJob = {
        ...currentJob,
        status: 'completed',
        text: 'final answer',
        tools: [
          { id: 't-live', name: 'terminal', status: 'completed', inputPreview: 'ls -la' },
          { id: 't-extra', name: 'memory', status: 'completed', inputPreview: 'save note' },
        ],
        timeline: [
          { kind: 'thought', text: 'live turn thought' },
          { kind: 'commentary', text: 'Checking live state...' },
          { kind: 'tool', toolId: 't-live' },
          { kind: 'tool', toolId: 't-extra' },
          { kind: 'text', text: 'final answer' },
        ],
      };
      historyMessages = [
        ...historyMessages,
        { id: 'm3', role: 'user', text: 'current prompt' },
        {
          id: 'm4',
          role: 'assistant',
          text: 'final answer',
          thought: 'live turn thought',
          tools: [{ id: 't-live', name: 'terminal', status: 'completed', inputPreview: 'ls -la' }],
        },
      ];
      // Re-open session to load the updated history and completed job
      const backBtn = findButton(liveTree, '助手设置');
      expect(backBtn).toBeDefined();
      (backBtn!.props.onClick as () => void)();
      const backDash = await flush();
      (findButton(backDash, '对话')!.props.onClick as () => void)();
      const reopened = await flush();
      (findButton(reopened, 'Live session')!.props.onClick as () => void)();
      const settledTree = await flush();
      const settledTexts = collectText(settledTree);
      expect(settledTexts.filter((t) => t === 'final answer')).toHaveLength(1);
      expect(settledTexts.filter((t) => t === 'live turn thought')).toHaveLength(1);
      expect(settledTexts.filter((t) => t === 'ls -la')).toHaveLength(1);
      expect(settledTexts).toContain('Checking live state...');
      expect(settledTexts).toContain('save note');

      for (const cleanup of cleanups) cleanup();
      await fiber.dispose();
    } finally {
      mod._load = origLoad;
    }
  });
});
