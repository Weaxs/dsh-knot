import { isIP } from 'node:net';
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
  if (typeof agent.id !== 'string' || !ID.test(agent.id))
    throw new ConfigError(`invalid agent id: ${String(agent.id)}`);
  if (ids.has(agent.id)) throw new ConfigError(`duplicate agent id: ${agent.id}`);
  ids.add(agent.id);
  if (!['hermes', 'openclaw', 'dsh', 'acp'].includes(agent.kind))
    throw new ConfigError(`${agent.id}: kind must be hermes, openclaw, dsh, or acp`);
  const transport = agent.transport ?? 'direct';
  if (transport !== 'direct' && transport !== 'local') throw new ConfigError(`${agent.id}: invalid transport`);
  if (agent.acpTransport === 'stdio') {
    if (agent.kind !== 'acp') throw new ConfigError(`${agent.id}: acpTransport requires kind acp`);
    if (transport !== 'local') throw new ConfigError(`${agent.id}: ACP stdio requires local transport`);
    if (typeof agent.acpCommand !== 'string' || !agent.acpCommand.trim()) {
      throw new ConfigError(`${agent.id}: ACP stdio requires acpCommand`);
    }
  }

  if (agent.host !== undefined && typeof agent.host !== 'string') throw new ConfigError(`${agent.id}: invalid host`);
  let parsedHost = agent.host?.trim() || (transport === 'local' ? '127.0.0.1' : '');
  let parsedPort = agent.port;
  let parsedTls = agent.tls;
  let parsedBasePath = agent.basePath;
  const isWebSocket = agent.kind === 'acp' || agent.kind === 'openclaw';

  if (/^(https?|wss?):\/\//i.test(parsedHost)) {
    let url: URL;
    try {
      url = new URL(parsedHost);
    } catch {
      throw new ConfigError(`${agent.id}: invalid endpoint URL`);
    }
    if (!url.hostname || url.username || url.password || url.href.includes('?') || url.href.includes('#')) {
      throw new ConfigError(`${agent.id}: endpoint URL must not contain credentials, a query, or a fragment`);
    }
    // URL.pathname is "/" even when the endpoint omits a path.
    const hasPath = parsedHost.includes('/', parsedHost.indexOf('://') + 3) || url.pathname !== '/';
    parsedHost = url.hostname;
    parsedTls = url.protocol === 'https:' || url.protocol === 'wss:';
    parsedPort = url.port ? Number(url.port) : parsedTls ? 443 : 80;
    parsedBasePath = isWebSocket && !hasPath ? undefined : url.pathname;
  }
  if (!parsedHost) throw new ConfigError(`${agent.id}: direct transport requires a gateway endpoint`);
  if (parsedHost.startsWith('[') && parsedHost.endsWith(']')) parsedHost = parsedHost.slice(1, -1);
  if (!isIP(parsedHost) && !/^[\p{L}\p{N}_][\p{L}\p{N}_.-]*$/u.test(parsedHost)) {
    throw new ConfigError(`${agent.id}: invalid host or endpoint URL`);
  }

  if (parsedBasePath !== undefined) {
    if (typeof parsedBasePath !== 'string') throw new ConfigError(`${agent.id}: invalid basePath`);
    const trimmed = parsedBasePath.trim();
    if (trimmed && (!trimmed.startsWith('/') || /[\s?#\\]/.test(trimmed))) {
      throw new ConfigError(`${agent.id}: basePath must be a URL path starting with "/"`);
    }
    parsedBasePath = (isWebSocket ? trimmed : trimmed.replace(/\/+$/, '')) || undefined;
  }
  if (agent.kind === 'acp' && agent.acpTransport !== 'stdio') parsedBasePath ??= '/acp';

  const defaultPort =
    parsedTls === true
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
    host: parsedHost,
    ...(parsedTls !== undefined ? { tls: parsedTls } : {}),
    basePath: parsedBasePath,
    port: parsedPort ?? defaultPort,
  };
  if (result.basePath === undefined) delete result.basePath;
  port(result.port!, `${agent.id}.port`);
  if (
    result.acpArgs !== undefined &&
    (!Array.isArray(result.acpArgs) || result.acpArgs.some((arg) => typeof arg !== 'string'))
  ) {
    throw new ConfigError(`${agent.id}: acpArgs must be strings`);
  }
  if (
    result.connectTimeoutMs !== undefined &&
    (!Number.isInteger(result.connectTimeoutMs) ||
      result.connectTimeoutMs < 100 ||
      result.connectTimeoutMs > 2_147_483_647)
  ) {
    throw new ConfigError(`${agent.id}: invalid connectTimeoutMs`);
  }
  return result;
}

function port(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new ConfigError(`${name} must be a TCP port`);
}

export function urlHost(host: string): string {
  return isIP(host) === 6 ? `[${host}]` : host;
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
