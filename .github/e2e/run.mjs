import { randomUUID } from 'node:crypto';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { raceAbort } from '../../dist/config.js';
import { AgentManager } from '../../dist/manager.js';

const mode = process.env.E2E_TRANSPORT ?? 'local';
const protocol = process.env.E2E_PROTOCOL ?? 'native';
const network = process.env.E2E_MODE_LABEL ?? mode;
const label = `${network}/${protocol}`;
const encryptedOverlay = mode === 'direct' && (network === 'tailscale' || network === 'headscale');
const timeoutMs = Number(process.env.E2E_TASK_TIMEOUT_MS ?? 180_000);

if (mode !== 'local' && mode !== 'direct') throw new Error(`Unsupported E2E transport: ${mode}`);

for (const name of ['OPENAI_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_MODEL_NAME']) {
  if (!process.env[name]) throw new Error(`${name} is required for real model-backed E2E tests`);
}

function agentConfig(target) {
  if (target !== 'dsh') {
    if (!process.env.E2E_PASEO_PORT || !process.env.E2E_PASEO_PROVIDER || !process.env.E2E_PASEO_CWD) {
      throw new Error('A test Paseo daemon must be configured by run-compose.sh');
    }
    return {
      id: `${target}-${label}`,
      kind: 'paseo',
      transport: 'local',
      port: Number(process.env.E2E_PASEO_PORT),
      token: process.env.E2E_PASEO_PASSWORD,
      paseoProvider: process.env.E2E_PASEO_PROVIDER,
      dshCwd: process.env.E2E_PASEO_CWD,
      connectTimeoutMs: 30_000,
    };
  }
  return {
    id: `dsh-${label}`,
    kind: 'dsh',
    transport: mode,
    host: process.env.DSH_HOST ?? '127.0.0.1',
    port: Number(process.env.DSH_PORT ?? 18790),
    encryptedOverlay,
    token: process.env.DSH_GATEWAY_TOKEN,
    model: process.env.OPENAI_MODEL_NAME,
    dshProvider: 'openai',
    dshCwd: '/tmp',
    reasoningEffort: 'low',
    connectTimeoutMs: 30_000,
  };
}

async function verify(kind) {
  const config = agentConfig(kind);
  let manager = new AgentManager([config], timeoutMs);
  const marker = `AL-${randomUUID().slice(0, 8).toUpperCase()}`;
  const startedAt = Date.now();
  try {
    console.log(`[e2e] ${label}/${kind}: health check`);
    const deadline = AbortSignal.timeout(120_000);
    let waitingReason = '';
    while (true) {
      try {
        await manager.adapter(config.id).health();
        break;
      } catch (error) {
        const message = `${String(error?.message ?? error)} ${String(error?.data?.details ?? '')}`;
        const pairing = /pairing|not approved|not-paired/i.test(message);
        const transient =
          /ETIMEDOUT|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|socket hang up|failed to connect|transport closed|connection closed|configured provider is unavailable|timed out|timeout/i.test(
            message,
          );
        if ((!pairing && !transient) || deadline.aborted) throw error;
        const reason = pairing ? 'waiting for OpenClaw device approval' : 'waiting for the transport to become ready';
        if (waitingReason !== reason) console.log(`[e2e] ${label}/${kind}: ${reason}`);
        waitingReason = reason;
        if (config.kind === 'paseo' && /configured provider is unavailable/.test(message)) {
          // The first ACP probe can fail before the isolated OpenClaw approver runs.
          const daemon = new DaemonClient({
            url: `ws://127.0.0.1:${config.port}/ws`,
            password: config.token,
            clientId: `dsh-knot-e2e-${randomUUID()}`,
            clientType: 'cli',
            reconnect: { enabled: false },
          });
          try {
            await raceAbort(daemon.connect(), deadline);
            await raceAbort(daemon.refreshProvidersSnapshot({ providers: [config.paseoProvider] }), deadline);
          } finally {
            await daemon.close();
          }
        }
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

    const sessions = await manager.adapter(config.id).listSessions();
    if (config.kind === 'paseo' && !sessions.some((session) => session.id === firstResult.sessionId)) {
      throw new Error(`${kind} did not list the Paseo session created by the test`);
    }
    await manager.close();
    manager = new AgentManager([config], timeoutMs);
    const second = manager.start(
      config.id,
      `Repeat the token I asked you to remember. Reply with only that token and no other text. Do not call any tools.`,
      firstResult.sessionId,
    );
    const secondResult = await manager.wait(second.id);
    assertCompleted(secondResult, marker, 'same-session continuation after reconnect');
    if (secondResult.sessionId !== firstResult.sessionId) {
      throw new Error(`${kind} did not reopen the original session`);
    }
    console.log(`[e2e] ${label}/${kind}: ${sessions.length} visible session(s) after the task`);
    console.log(`E2E_PASS ${label}/${kind} session=${firstResult.sessionId} elapsedMs=${Date.now() - startedAt}`);
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
const targets = (process.env.E2E_TARGET ?? 'dsh').split(',').filter(Boolean);
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
