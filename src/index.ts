import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { normalizeConfig } from './config.js';
import { AgentManager } from './manager.js';
import { McpServer } from './mcp/server.js';
import type { SessionControllerLike } from './mcp/session-service.js';
import { loadStoredState } from './store.js';
import { registerTools } from './tools.js';
import type { PluginConfig } from './types.js';
import { registerWebRoutes } from './web/routes.js';

export const name = 'knot';
export const inject = ['tools'];

export const Config = Schema.object({
  agents: Schema.array(
    Schema.object({
      id: Schema.string().required().description('Unique agent identifier (letters, digits, ., _, -).'),
      kind: Schema.union(['dsh', 'paseo']).required().description('Target protocol adapter.'),
      transport: Schema.union(['direct', 'local']).description('Connectivity transport, defaults to direct.'),
      host: Schema.string().description('Target hostname or full HTTP(S)/WS(S) gateway endpoint URL.'),
      port: Schema.number().description('Target TCP port (defaults per protocol, or 443 for HTTPS).'),
      tls: Schema.boolean().description('Use HTTPS/WSS for direct transport.'),
      encryptedOverlay: Schema.boolean().description(
        'Enable only if the gateway path uses an encrypted private network.',
      ),
      basePath: Schema.string().description('HTTP path prefix or exact Gateway WebSocket path.'),
      token: Schema.string().role('secret').description('Paseo daemon password or Remote DSH launch token.'),
      tokenEnv: Schema.string().description('Optional environment variable fallback holding the token.'),
      model: Schema.string().description('Optional model override.'),
      dshCwd: Schema.string().description('Working directory on the agent host.'),
      paseoProvider: Schema.string().description('Provider ID registered on the Paseo daemon.'),
      connectTimeoutMs: Schema.number().description('Connection timeout in milliseconds.'),
    }),
  )
    .default([])
    .description('Configured remote agents.'),
  jobTimeoutMs: Schema.number()
    .min(1_000)
    .max(86_400_000)
    .default(1_800_000)
    .description('Maximum duration for a remote job in milliseconds.'),
  mcp: Schema.object({
    enabled: Schema.boolean().default(false).description('Enable the separate read-only MCP listener.'),
    host: Schema.string().default('127.0.0.1').description('Loopback or Tailscale IP (never 0.0.0.0 or ::).'),
    port: Schema.number().min(1).max(65_535).default(19_400).description('Read-only MCP listener port.'),
    token: Schema.string().role('secret').description('Bearer token protecting the read-only MCP listener.'),
    tokenEnv: Schema.string()
      .default('DSH_KNOT_TOKEN')
      .description('Optional environment variable fallback holding the MCP bearer token.'),
    allowSessions: Schema.array(Schema.string())
      .default([])
      .description('Exact local dsh session IDs permitted for read-only MCP access (empty shares nothing).'),
  }).description('Optional reverse read-only MCP export.'),
});

function getService<T>(ctx: Context, key: string): T | undefined {
  if (typeof (ctx as unknown as { get?: (name: string) => unknown }).get === 'function') {
    return (ctx as unknown as { get: (name: string) => unknown }).get(key) as T | undefined;
  }
  return (ctx as unknown as Record<string, unknown>)[key] as T | undefined;
}

export async function apply(ctx: Context, input: PluginConfig = {}): Promise<void> {
  const config = normalizeConfig(input);
  const stored = loadStoredState();
  const deleted = new Set(stored.deletedIds);
  const merged = config.agents.filter((item) => !deleted.has(item.id));
  for (const agent of stored.agents) {
    const idx = merged.findIndex((item) => item.id === agent.id);
    if (idx >= 0) merged[idx] = agent;
    else merged.push(agent);
  }
  const manager = new AgentManager(merged, config.jobTimeoutMs);
  registerTools(ctx, manager);
  const sessions = getService<SessionControllerLike>(ctx, 'sessionController');
  let mcp: McpServer | undefined;
  if (config.mcp?.enabled) {
    if (!sessions) throw new Error('MCP sharing requires the dsh sessionController service');
    const mcpConfig =
      stored.allowSessions !== undefined ? { ...config.mcp, allowSessions: stored.allowSessions } : config.mcp;
    mcp = new McpServer(mcpConfig, sessions);
    await mcp.start();
  }
  registerWebRoutes(ctx, manager, mcp, () => getService<SessionControllerLike>(ctx, 'sessionController'));
  ctx.effect(() => async () => {
    await mcp?.close();
    await manager.close();
  });
}

export { DshAdapter } from './adapters/dsh.js';
export { PaseoAdapter } from './adapters/paseo.js';
export { normalizeConfig } from './config.js';
export { runDoctor } from './doctor.js';
export { AgentManager } from './manager.js';
export { McpServer } from './mcp/server.js';
export { redact, redactText } from './policy/redact.js';
export { NodeHttpTransport, transportFor } from './transports/http.js';
export type * from './types.js';
