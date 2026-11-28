import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runDoctor } from '../src/doctor.js';
import { apply } from '../src/index.js';
import { AgentManager } from '../src/manager.js';
import { registerTools } from '../src/tools.js';
import type { AgentAdapter, AgentConfig, AgentEvent } from '../src/types.js';

class MockAdapter implements AgentAdapter {
  readonly kind = 'dsh' as const;
  lastSignal?: AbortSignal;
  closed = false;
  constructor(readonly id: string) {}
  async health(signal?: AbortSignal) {
    this.lastSignal = signal;
    return { ok: true, id: this.id };
  }
  async listSessions() {
    return [];
  }
  async *prompt(): AsyncIterable<AgentEvent> {
    yield { type: 'thought', text: 'UI-only thought' };
    yield { type: 'tool', phase: 'start', name: 'terminal', title: 'UI-only title', inputPreview: 'UI-only command' };
    yield { type: 'tool', phase: 'end', name: 'terminal' };
    yield { type: 'final', text: 'done' };
  }
  async cancel(_sessionId: string, signal?: AbortSignal) {
    this.lastSignal = signal;
  }
  async respond(_sessionId: string, _requestId: string, _choice: string, signal?: AbortSignal) {
    this.lastSignal = signal;
  }
  async close() {
    this.closed = true;
  }
}

describe('plugin entry, tools and doctor', () => {
  it('registers all 7 model tools, forwards exec.signal, and posts followup notifications', async () => {
    const registered = new Map<string, any>();
    const ctx = {
      tools: { register: (tool: any) => registered.set(tool.name, tool) },
    } as any;
    const config: AgentConfig = { id: 'local-dsh', kind: 'dsh', transport: 'local', port: 18790 };
    const adapter = new MockAdapter('local-dsh');
    const manager = new AgentManager([config], 10_000, () => adapter);
    registerTools(ctx, manager);

    expect([...registered.keys()].sort()).toEqual([
      'agent_ask',
      'agent_cancel',
      'agent_continue',
      'agent_list',
      'agent_respond',
      'agent_status',
      'knot_doctor',
    ]);

    const controller = new AbortController();
    const listResult = await registered.get('agent_list').execute({ health: true }, { signal: controller.signal });
    expect(listResult.agents[0].health).toEqual({ ok: true, id: 'local-dsh' });
    expect(adapter.lastSignal).toBe(controller.signal);

    const followups: unknown[] = [];
    const asked = await registered.get('agent_ask').execute(
      { agent: 'local-dsh', task: 'hello', wait: true },
      {
        signal: controller.signal,
        agent: { followup: (msg: unknown) => followups.push(msg) },
      },
    );
    expect(asked.status).toBe('completed');
    expect(asked.text).toBe('done');
    expect(asked).not.toHaveProperty('thought');
    expect(followups).toHaveLength(1);
    expect(manager.get(asked.id).thought).toBe('UI-only thought');
    expect(manager.get(asked.id).tools?.[0]?.inputPreview).toBe('UI-only command');
    expect(manager.get(asked.id).tools?.[0]?.title).toBe('UI-only title');
    expect(asked.tools).toEqual([{ id: expect.any(String), name: 'terminal', status: 'completed' }]);
    expect(JSON.stringify(followups)).not.toContain('UI-only command');
    expect(JSON.stringify(followups)).not.toContain('UI-only title');
    expect(JSON.stringify(followups)).not.toContain('UI-only thought');

    const doctorResult = await runDoctor(manager, 'local-dsh', controller.signal);
    expect(doctorResult.agents[0]?.steps.every((step) => step.ok)).toBe(true);
  });

  it('registers cleanup via ctx.effect and rejects MCP without sessionController', async () => {
    const cleanups: Array<() => Promise<void>> = [];
    const registered: string[] = [];
    const ctx = {
      tools: { register: (tool: any) => registered.push(tool.name) },
      effect: (fn: () => () => Promise<void>) => cleanups.push(fn()),
    } as any;

    const stateDir = mkdtempSync(join(tmpdir(), 'dsh-knot-plugin-'));
    vi.stubEnv('DSH_KNOT_STATE_DIR', stateDir);
    writeFileSync(
      join(stateDir, 'agents.json'),
      JSON.stringify({
        agents: [
          { id: 'old-hermes', kind: 'hermes' },
          { id: 'kept', kind: 'paseo', host: '127.0.0.1', paseoProvider: 'test', dshCwd: '/work' },
        ],
      }),
    );
    try {
      await apply(ctx, { agents: [{ id: 'a', kind: 'dsh', transport: 'local' }] });
      expect(registered).toHaveLength(7);
      expect(cleanups).toHaveLength(1);
      await cleanups[0]!();

      await expect(apply(ctx, { mcp: { enabled: true, token: 'tok' } })).rejects.toThrow(/sessionController/);
    } finally {
      vi.unstubAllEnvs();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
