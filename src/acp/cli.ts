#!/usr/bin/env node
import { normalizeConfig } from '../config.js';
import type { AgentConfig, AgentKind } from '../types.js';
import { AcpBridge, runAcpStdio } from './bridge.js';

const kind = process.env.DSH_KNOT_NATIVE_KIND;
if (!kind || !['hermes', 'openclaw', 'dsh'].includes(kind)) {
  throw new Error('DSH_KNOT_NATIVE_KIND must be hermes, openclaw, or dsh');
}
const defaultPort = kind === 'openclaw' ? 18_789 : kind === 'dsh' ? 18_790 : 8_642;
const config: AgentConfig = {
  id: process.env.DSH_KNOT_NATIVE_ID ?? `${kind}-acp-bridge`,
  kind: kind as AgentKind,
  transport: 'local',
  host: process.env.DSH_KNOT_NATIVE_HOST ?? '127.0.0.1',
  port: Number(process.env.DSH_KNOT_NATIVE_PORT ?? (process.env.DSH_KNOT_NATIVE_TLS === '1' ? 443 : defaultPort)),
  ...(process.env.DSH_KNOT_NATIVE_TLS === '1' ? { tls: true } : {}),
  ...(process.env.DSH_KNOT_NATIVE_ENCRYPTED_OVERLAY === '1' ? { encryptedOverlay: true } : {}),
  ...(process.env.DSH_KNOT_NATIVE_TOKEN ? { token: process.env.DSH_KNOT_NATIVE_TOKEN } : {}),
  model: process.env.OPENAI_MODEL_NAME,
  dshProvider: process.env.DSH_KNOT_DSH_PROVIDER,
  dshCwd: process.env.DSH_KNOT_NATIVE_CWD,
  openclawAgentId: process.env.DSH_KNOT_OPENCLAW_AGENT_ID,
  reasoningEffort: process.env.DSH_KNOT_REASONING_EFFORT,
};
const native = normalizeConfig({ agents: [config] }).agents[0]!;
if (process.env.DSH_KNOT_ACP_STDIO === '1') {
  await runAcpStdio(native);
} else {
  const bridge = new AcpBridge(native);
  const address = await bridge.start({
    host: process.env.DSH_KNOT_ACP_HOST,
    port: Number(process.env.DSH_KNOT_ACP_PORT ?? 18_792),
    token: process.env.DSH_KNOT_ACP_TOKEN,
  });
  console.log(`ACP bridge for ${kind} listening on ${address.host}:${address.port}`);
  for (const event of ['SIGINT', 'SIGTERM']) {
    process.once(event, () => {
      void bridge.close().then(() => {
        process.exitCode = 0;
      });
    });
  }
}
