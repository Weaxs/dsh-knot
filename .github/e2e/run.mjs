import { randomUUID } from 'node:crypto';
import { AgentManager } from '../../dist/manager.js';

const mode = process.env.E2E_TRANSPORT ?? 'local';
const protocol = process.env.E2E_PROTOCOL ?? 'native';
const label = `${process.env.E2E_MODE_LABEL ?? mode}/${protocol}`;
const timeoutMs = Number(process.env.E2E_TASK_TIMEOUT_MS ?? 180_000);

if (mode !== 'local' && mode !== 'direct') throw new Error(`Unsupported E2E transport: ${mode}`);

for (const name of ['OPENAI_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_MODEL_NAME']) {
  if (!process.env[name]) throw new Error(`${name} is required for real model-backed E2E tests`);
}

function agentConfig(kind) {
  const upper = kind.toUpperCase();
  const transport = mode;
  const host = process.env[`${upper}_HOST`] ?? '127.0.0.1';
  if (protocol === 'acp') {
    return {
      id: `acp-${kind}-${label}`,
      kind: 'acp',
      transport,
      host,
      port: 18792,
      token: 'e2e-acp-token',
      dshCwd: '/tmp',
      connectTimeoutMs: 30_000,
    };
  }
  return {
    id: `${kind}-${label}`,
    kind,
    transport,
    host,
    port: Number(process.env[`${upper}_PORT`] ?? (kind === 'hermes' ? 8642 : kind === 'openclaw' ? 18789 : 18790)),
    token:
      process.env[
        kind === 'hermes' ? 'HERMES_API_KEY' : kind === 'openclaw' ? 'OPENCLAW_GATEWAY_TOKEN' : 'DSH_GATEWAY_TOKEN'
      ],
    ...(kind === 'openclaw' ? { origin: 'http://127.0.0.1:18789', openclawAgentId: 'main' } : {}),
    ...(kind === 'dsh'
      ? { model: process.env.OPENAI_MODEL_NAME, dshProvider: 'openai', dshCwd: '/tmp', reasoningEffort: 'low' }
      : {}),
    connectTimeoutMs: 30_000,
  };
}

async function verify(kind) {
  const config = agentConfig(kind);
  const manager = new AgentManager([config], timeoutMs);
  const marker = `AL-${randomUUID().slice(0, 8).toUpperCase()}`;
  const startedAt = Date.now();
  try {
    console.log(`[e2e] ${label}/${kind}: health check`);
    const deadline = Date.now() + 90_000;
    let waitingReason = '';
    while (true) {
      try {
        await manager.adapter(config.id).health();
        break;
      } catch (error) {
        const message = `${String(error?.message ?? error)} ${String(error?.data?.details ?? '')}`;
        const pairing = /pairing|not approved|not-paired/i.test(message);
        const transient =
          /ETIMEDOUT|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|socket hang up|timed out|timeout/i.test(message);
        if ((!pairing && !transient) || Date.now() >= deadline) throw error;
        const reason = pairing ? 'waiting for OpenClaw device approval' : 'waiting for the transport to become ready';
        if (waitingReason !== reason) console.log(`[e2e] ${label}/${kind}: ${reason}`);
        waitingReason = reason;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
    console.log(`[e2e] ${label}/${kind}: health check passed; starting model task`);
    const first = manager.start(
      config.id,
      `Remember this exact token: ${marker}. Reply with only ${marker} and no other text. Do not call any tools.`,
      undefined,
    );
    const firstResult = await manager.wait(first.id);
    assertCompleted(firstResult, marker, 'initial task');

    const second = manager.start(
      config.id,
      `Repeat the token I asked you to remember. Reply with only that token and no other text. Do not call any tools.`,
      first.sessionId,
    );
    const secondResult = await manager.wait(second.id);
    assertCompleted(secondResult, marker, 'same-session continuation');

    const sessions = await manager.adapter(config.id).listSessions();
    if (kind === 'hermes' && !sessions.some((session) => session.id === firstResult.sessionId)) {
      throw new Error('Hermes did not list the API session created by the test');
    }
    console.log(`[e2e] ${label}/${kind}: ${sessions.length} visible session(s) after the task`);
    console.log(`E2E_PASS ${label}/${kind} session=${first.sessionId} elapsedMs=${Date.now() - startedAt}`);
  } finally {
    await manager.close();
  }
}

function assertCompleted(job, marker, stage) {
  if (job.status !== 'completed') {
    throw new Error(`${stage} failed with status ${job.status}: ${job.error ?? '(no error)'}\n${JSON.stringify(job)}`);
  }
  if (!job.text.includes(marker)) {
    throw new Error(`${stage} did not return the expected token ${marker}: ${JSON.stringify(job.text)}`);
  }
}

const failures = [];
const targets = (process.env.E2E_TARGET ?? 'hermes,openclaw').split(',').filter(Boolean);
for (const kind of targets) {
  try {
    await verify(kind);
  } catch (error) {
    failures.push(kind);
    console.error(`[e2e] ${label}/${kind}: FAILED`, error);
  }
}
if (failures.length > 0) throw new Error(`${label}: transport tests failed for ${failures.join(', ')}`);
console.log(`E2E_PASS ${label}: ${targets.join(', ')} completed real model-backed tasks and continuations`);
