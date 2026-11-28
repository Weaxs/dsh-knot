import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PaseoAdapter } from '../src/adapters/paseo.js';
import { AgentManager } from '../src/manager.js';

const sdk = vi.hoisted(() => ({
  daemon: {
    connect: vi.fn(),
    subscribeConnectionStatus: vi.fn(),
    createAgent: vi.fn(),
    cancelAgent: vi.fn(),
    respondToPermissionAndWait: vi.fn(),
    close: vi.fn(),
  },
  agent: {
    refresh: vi.fn(),
    send: vi.fn(),
    timeline: { subscribe: vi.fn() },
  },
  snapshot: vi.fn(),
  list: vi.fn(),
  dispose: vi.fn(),
}));

vi.mock('@getpaseo/client', () => ({
  createPaseoApi: () => ({
    agents: { ref: () => sdk.agent, list: sdk.list },
    providers: { snapshot: sdk.snapshot },
    dispose: sdk.dispose,
  }),
}));
vi.mock('@getpaseo/client/internal/daemon-client', () => ({
  DaemonClient: class {
    constructor() {
      Object.assign(this, sdk.daemon);
    }
  },
}));

describe('Paseo adapter', () => {
  let adapter: PaseoAdapter;
  let emit: (update: unknown) => void;
  let disconnect: () => void;
  const config = {
    id: 'agent',
    kind: 'paseo',
    transport: 'local',
    paseoProvider: 'fixture',
    dshCwd: '/tmp',
    token: 'fixture-password',
  } as const;
  const idleAgent = {
    provider: 'fixture',
    labels: { 'dsh-knot': 'agent' },
    pendingPermissions: [],
    status: 'idle',
  };

  beforeEach(() => {
    vi.resetAllMocks();
    sdk.daemon.subscribeConnectionStatus.mockImplementation((listener) => {
      disconnect = () => listener({ status: 'disconnected' });
      return () => {};
    });
    sdk.agent.timeline.subscribe.mockImplementation((listener) => {
      emit = (event) => listener({ event });
      return Object.assign(() => {}, { ready: Promise.resolve() });
    });
    sdk.agent.refresh.mockResolvedValue({ agent: idleAgent });
    sdk.daemon.respondToPermissionAndWait.mockResolvedValue(undefined);
    adapter = new PaseoAdapter(config.id, config);
  });

  it('lists the ready provider while another provider is loading', async () => {
    sdk.snapshot.mockResolvedValue({
      entries: [
        { provider: 'fixture', label: 'Test provider', enabled: true, status: 'ready' },
        { provider: 'slow', enabled: true, status: 'loading' },
      ],
    });
    try {
      await expect(adapter.listProviders()).resolves.toEqual([{ id: 'fixture', label: 'Test provider' }]);
      await expect(adapter.health()).resolves.toMatchObject({ ok: true, provider: 'fixture' });
    } finally {
      await adapter.close();
    }
  });

  it('releases a cancelled session list even when the SDK request is still pending', async () => {
    const controller = new AbortController();
    sdk.list.mockImplementation(() => {
      queueMicrotask(() => controller.abort(new Error('Cancelled by caller')));
      return new Promise(() => {});
    });
    try {
      await expect(adapter.listSessions(controller.signal)).rejects.toThrow('Cancelled by caller');
    } finally {
      await adapter.close();
    }
  });

  it('ignores unrelated events and confirms only the owned turn after a stop', async () => {
    const stream = adapter.prompt(undefined, 'hello')[Symbol.asyncIterator]();
    try {
      const { value } = await stream.next();
      const id = value.sessionId;
      expect(sdk.daemon.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: id, provider: 'fixture', labels: { 'dsh-knot': 'agent' } }),
      );
      sdk.agent.send.mockImplementation((_text, { messageId }) => {
        emit({ type: 'turn_completed', turnId: 'other' });
        emit({ type: 'timeline', turnId: 'ours', item: { type: 'user_message', clientMessageId: messageId } });
        emit({ type: 'timeline', turnId: 'other', item: { type: 'assistant_message', text: 'unrelated' } });
        emit({ type: 'timeline', turnId: 'ours', item: { type: 'assistant_message', text: 'hello back' } });
      });
      await expect(stream.next()).resolves.toMatchObject({ value: { type: 'text', text: 'hello back' } });
      const terminal = adapter.promptTerminalForCancel(id);
      expect(terminal).toBeDefined();

      sdk.agent.refresh.mockResolvedValue({ agent: { ...idleAgent, activeTurn: { turnId: 'ours' } } });
      sdk.daemon.cancelAgent.mockImplementation(() => {
        emit({ type: 'turn_canceled', turnId: 'ours' });
      });
      await adapter.cancel(id);
      await expect(terminal).resolves.toBeUndefined();
      expect(sdk.daemon.cancelAgent).toHaveBeenCalledWith(id);
      await expect(stream.next()).resolves.toMatchObject({ value: { type: 'final', stopReason: 'cancelled' } });
      await expect(stream.next()).resolves.toMatchObject({ done: true });
      expect(adapter.isSessionBusy(id)).toBe(false);
    } finally {
      await adapter.close();
      await stream.return?.();
    }
  });

  it('skips a stop when the owned turn completed during the agent refresh', async () => {
    const stream = adapter.prompt(undefined, 'hello')[Symbol.asyncIterator]();
    try {
      const { value } = await stream.next();
      sdk.agent.send.mockImplementation((_text, { messageId }) => {
        emit({ type: 'timeline', turnId: 'ours', item: { type: 'user_message', clientMessageId: messageId } });
        emit({ type: 'timeline', turnId: 'ours', item: { type: 'assistant_message', text: 'hello back' } });
      });
      await stream.next();
      sdk.agent.refresh.mockImplementation(() => {
        emit({ type: 'turn_completed', turnId: 'ours' });
        return { agent: { ...idleAgent, activeTurn: { turnId: 'ours' } } };
      });
      await adapter.cancel(value.sessionId);
      expect(sdk.daemon.cancelAgent).not.toHaveBeenCalled();
      await expect(stream.next()).resolves.toMatchObject({ value: { type: 'final', stopReason: 'end_turn' } });
    } finally {
      await adapter.close();
      await stream.return?.();
    }
  });

  it('resends an unanswered question after the caller cancels and the first send fails', async () => {
    const stream = adapter.prompt(undefined, 'hello')[Symbol.asyncIterator]();
    try {
      const { value } = await stream.next();
      sdk.agent.send.mockImplementation((_text, { messageId }) => {
        emit({ type: 'timeline', turnId: 'ours', item: { type: 'user_message', clientMessageId: messageId } });
        emit({
          type: 'permission_requested',
          request: {
            id: 'question',
            kind: 'question',
            input: { questions: [{ header: 'Theme', question: 'Pick a theme', options: [{ label: 'Dark' }] }] },
          },
        });
      });
      await expect(stream.next()).resolves.toMatchObject({
        value: { type: 'approval', choices: [], questions: [{ text: 'Pick a theme', options: ['Dark'] }] },
      });
      const controller = new AbortController();
      let fail!: (error: Error) => void;
      sdk.daemon.respondToPermissionAndWait.mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            fail = reject;
            queueMicrotask(() => controller.abort(new Error('Caller cancelled')));
          }),
      );
      await expect(adapter.respond(value.sessionId, 'question', '["Dark"]', controller.signal)).rejects.toThrow(
        'Caller cancelled',
      );
      fail(new Error('No acknowledgement'));
      await vi.waitFor(async () => {
        await expect(adapter.respond(value.sessionId, 'question', '["Dark"]')).resolves.toBeUndefined();
      });
      expect(sdk.daemon.respondToPermissionAndWait).toHaveBeenLastCalledWith(
        value.sessionId,
        'question',
        { behavior: 'allow', updatedInput: { answers: { Theme: 'Dark' } } },
        15_000,
      );
      await expect(stream.next()).resolves.toMatchObject({ value: { type: 'approval', phase: 'end' } });
      emit({ type: 'turn_completed', turnId: 'ours' });
      await stream.next();
    } finally {
      await adapter.close();
      await stream.return?.();
    }
  });

  it.each([true, false])('recovers a disconnected job (original turn still active: %s)', async (stillActive) => {
    const manager = new AgentManager([config], 5_000, () => adapter);
    try {
      sdk.agent.send.mockImplementation((_text, { messageId }) => {
        emit({ type: 'timeline', turnId: 'ours', item: { type: 'user_message', clientMessageId: messageId } });
        disconnect();
      });
      const job = manager.start(config.id, 'hello', undefined);
      const failed = await manager.wait(job.id);
      expect(failed).toMatchObject({ status: 'failed', remoteStop: 'unconfirmed' });
      sdk.agent.refresh.mockResolvedValueOnce({
        agent: { ...idleAgent, activeTurn: { turnId: stillActive ? 'ours' : 'newer' } },
      });
      const recovered = await manager.cancel(job.id);
      expect(recovered.remoteStop).toBeUndefined();
      expect(sdk.daemon.cancelAgent).toHaveBeenCalledTimes(stillActive ? 1 : 0);
    } finally {
      await manager.close();
    }
  });

  it('releases a message that the daemon accepts without starting a turn', async () => {
    adapter = new PaseoAdapter(config.id, { ...config, connectTimeoutMs: 50 });
    const stream = adapter.prompt(undefined, 'out-of-band command')[Symbol.asyncIterator]();
    try {
      const { value } = await stream.next();
      await expect(stream.next()).rejects.toThrow('without starting an observable turn');
      expect(adapter.isSessionBusy(value.sessionId)).toBe(false);
      expect(sdk.daemon.cancelAgent).not.toHaveBeenCalled();
    } finally {
      await adapter.close();
      await stream.return?.();
    }
  });

  it('releases a rejected submission and redacts the daemon password', async () => {
    sdk.agent.send.mockRejectedValue(new Error('Rejected fixture-password'));
    const stream = adapter.prompt(undefined, 'hello')[Symbol.asyncIterator]();
    try {
      const { value } = await stream.next();
      await expect(stream.next()).rejects.toThrow('Rejected [REDACTED]');
      expect(adapter.isSessionBusy(value.sessionId)).toBe(false);
      expect(sdk.daemon.cancelAgent).not.toHaveBeenCalled();
    } finally {
      await adapter.close();
      await stream.return?.();
    }
  });
});
