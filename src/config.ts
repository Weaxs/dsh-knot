import type { AgentConfig, PluginConfig } from './types.js';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;

export function normalizeConfig(
  input: PluginConfig = {},
): Required<Pick<PluginConfig, 'agents' | 'jobTimeoutMs'>> & PluginConfig {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new ConfigError('config must be an object');
  if (input.agents !== undefined && !Array.isArray(input.agents)) throw new ConfigError('agents must be an array');
  const ids = new Set<string>();
  const agents = (input.agents ?? []).map((agent) => normalizeAgent(agent, ids));
  const timeout = input.jobTimeoutMs ?? 1_800_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > 86_400_000) {
    throw new ConfigError('jobTimeoutMs must be between 1000 and 86400000');
  }
  if (input.mcp?.port !== undefined) port(input.mcp.port, 'mcp.port');
  if (input.mcp?.host === '0.0.0.0' || input.mcp?.host === '::') {
    throw new ConfigError('mcp.host must be loopback or a specific trusted address, never 0.0.0.0 or ::');
  }
  return { ...input, agents, jobTimeoutMs: timeout };
}

function normalizeAgent(agent: AgentConfig, ids: Set<string>): AgentConfig {
  if (typeof agent !== 'object' || agent === null) throw new ConfigError('each agent must be an object');
  if (!ID.test(agent.id)) throw new ConfigError(`invalid agent id: ${String(agent.id)}`);
  if (ids.has(agent.id)) throw new ConfigError(`duplicate agent id: ${agent.id}`);
  ids.add(agent.id);
  if (!['hermes', 'openclaw', 'dsh', 'acp'].includes(agent.kind))
    throw new ConfigError(`${agent.id}: kind must be hermes, openclaw, dsh, or acp`);
  const transport = agent.transport ?? 'ssh';
  if (!['ssh', 'direct', 'local'].includes(transport)) throw new ConfigError(`${agent.id}: invalid transport`);
  if (agent.ssh !== undefined && (agent.ssh.startsWith('-') || !/^\S+$/.test(agent.ssh))) {
    throw new ConfigError(`${agent.id}: ssh must be one host alias without spaces`);
  }
  if (agent.sshHost !== undefined && (agent.sshHost.startsWith('-') || !/^\S+$/.test(agent.sshHost))) {
    throw new ConfigError(`${agent.id}: sshHost must be a hostname or IP without spaces`);
  }
  if (agent.sshUser !== undefined && (agent.sshUser.startsWith('-') || !/^\S+$/.test(agent.sshUser))) {
    throw new ConfigError(`${agent.id}: sshUser must be a username without spaces`);
  }
  if (agent.sshPort !== undefined) port(agent.sshPort, `${agent.id}.sshPort`);
  if (
    agent.sshIdentityFile !== undefined &&
    (!agent.sshIdentityFile.trim() || agent.sshIdentityFile.startsWith('-') || /[\0\r\n]/.test(agent.sshIdentityFile))
  ) {
    throw new ConfigError(`${agent.id}: invalid sshIdentityFile`);
  }
  if (transport === 'ssh' && !agent.ssh && !agent.sshHost) {
    throw new ConfigError(`${agent.id}: ssh transport requires an ssh host alias or sshHost`);
  }

  let parsedHost = agent.host;
  let parsedPort = agent.port;
  let parsedTls = agent.tls;
  let parsedBasePath = agent.basePath;

  if (transport !== 'ssh' && typeof parsedHost === 'string' && /^(https?|wss?):\/\//i.test(parsedHost.trim())) {
    let url: URL;
    try {
      url = new URL(parsedHost.trim());
    } catch {
      throw new ConfigError(`${agent.id}: invalid endpoint URL`);
    }
    if (!url.hostname) throw new ConfigError(`${agent.id}: invalid endpoint URL`);
    parsedHost = url.hostname;
    const isSecure = url.protocol === 'https:' || url.protocol === 'wss:';
    if (isSecure) parsedTls = true;
    else if (parsedTls === undefined) parsedTls = false;
    if (parsedPort === undefined) {
      parsedPort = url.port ? Number(url.port) : isSecure ? 443 : 80;
    }
    if (parsedBasePath === undefined && url.pathname && url.pathname !== '/') {
      parsedBasePath = url.pathname;
    }
  }

  if (parsedBasePath !== undefined) {
    const trimmed = parsedBasePath.trim().replace(/\/+$/, '');
    if (trimmed && (!trimmed.startsWith('/') || /\s/.test(trimmed))) {
      throw new ConfigError(`${agent.id}: basePath must start with "/" and contain no spaces`);
    }
    parsedBasePath = trimmed || undefined;
  }

  const defaultPort =
    transport === 'direct' && parsedTls === true
      ? 443
      : agent.kind === 'openclaw'
        ? 18_789
        : agent.kind === 'dsh'
          ? 18_790
          : agent.kind === 'acp'
            ? 18_792
            : 8_642;
  const result: AgentConfig = {
    ...agent,
    transport,
    ...(parsedHost !== undefined ? { host: parsedHost } : {}),
    ...(parsedTls !== undefined ? { tls: parsedTls } : {}),
    ...(parsedBasePath !== undefined ? { basePath: parsedBasePath } : {}),
    port: parsedPort ?? defaultPort,
  };
  if (result.basePath === undefined) delete result.basePath;
  port(result.port!, `${agent.id}.port`);
  if (transport !== 'ssh' && !result.host) result.host = '127.0.0.1';
  if (result.host?.startsWith('-')) throw new ConfigError(`${agent.id}: invalid host`);
  if (
    result.acpRuntimeUser !== undefined &&
    (result.acpRuntimeUser.startsWith('-') || !/^\S+$/.test(result.acpRuntimeUser))
  ) {
    throw new ConfigError(`${agent.id}: acpRuntimeUser must be a username without spaces`);
  }
  if (result.acpLauncher !== undefined && (!result.acpLauncher.trim() || /[\0\r\n]/.test(result.acpLauncher))) {
    throw new ConfigError(`${agent.id}: invalid acpLauncher`);
  }
  if (result.acpTransport === 'stdio') {
    if (result.kind !== 'acp') throw new ConfigError(`${agent.id}: acpTransport requires kind acp`);
    if (transport === 'direct') throw new ConfigError(`${agent.id}: ACP stdio requires local or ssh transport`);
    if (!result.acpCommand?.trim() && !result.acpLauncher?.trim()) {
      throw new ConfigError(`${agent.id}: ACP stdio requires acpCommand or acpLauncher`);
    }
  }
  if (result.acpArgs?.some((argument) => typeof argument !== 'string')) {
    throw new ConfigError(`${agent.id}: acpArgs must be strings`);
  }
  if (
    result.connectTimeoutMs !== undefined &&
    (!Number.isSafeInteger(result.connectTimeoutMs) || result.connectTimeoutMs < 100)
  ) {
    throw new ConfigError(`${agent.id}: invalid connectTimeoutMs`);
  }
  return result;
}

function port(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new ConfigError(`${name} must be a TCP port`);
}

export function secret(agent: AgentConfig, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fallback =
    agent.kind === 'openclaw'
      ? 'OPENCLAW_GATEWAY_TOKEN'
      : agent.kind === 'dsh'
        ? 'DSH_GATEWAY_TOKEN'
        : agent.kind === 'acp'
          ? 'DSH_KNOT_ACP_TOKEN'
          : 'HERMES_API_KEY';
  return agent.token ?? env[agent.tokenEnv ?? fallback];
}

export class LocalOnlyAbortError extends Error {
  readonly skipRemoteCancel = true;
}

export function shouldSkipRemoteCancel(signal?: AbortSignal): boolean {
  return Boolean((signal?.reason as { skipRemoteCancel?: boolean } | undefined)?.skipRemoteCancel);
}

export async function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw signal.reason ?? new Error('request aborted');
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason ?? new Error('request aborted'));
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}
