import { LEGACY_SSH_ERROR, secret, urlHost } from './config.js';
import type { AgentManager } from './manager.js';
import { redactText } from './policy/redact.js';
import type { AgentConfig, DoctorStep } from './types.js';

export type { DoctorStep } from './types.js';

export async function runDoctor(
  manager: AgentManager,
  only?: string,
  signal?: AbortSignal,
): Promise<{ agents: Array<{ id: string; steps: DoctorStep[] }> }> {
  const configs = manager.configs.filter((config) => !only || config.id === only);
  if (only && configs.length === 0) throw new Error(`Unknown agent "${only}"`);
  return {
    agents: await Promise.all(
      configs.map(async (config) => {
        const steps: DoctorStep[] = [];
        if (config.transport === 'ssh') {
          steps.push({ name: 'transport', ok: false, detail: LEGACY_SSH_ERROR });
        } else {
          const isWebSocket = config.kind === 'openclaw' || config.kind === 'acp';
          const scheme = `${isWebSocket ? 'ws' : 'http'}${config.tls ? 's' : ''}`;
          const host = urlHost(config.host ?? '127.0.0.1');
          const detail =
            config.acpTransport === 'stdio'
              ? 'Starting a local ACP process.'
              : `Connecting to ${scheme}://${host}:${config.port}${config.basePath ?? ''}.`;
          steps.push({ name: `${config.transport ?? 'direct'}-transport`, ok: true, detail });
          const timeout = AbortSignal.timeout(config.connectTimeoutMs ?? 15_000);
          const healthSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
          try {
            const health = await manager.adapter(config.id).health(healthSignal);
            if (health.ok === false) throw new Error('The gateway reported unhealthy status.');
            steps.push({ name: 'gateway-health', ok: true, detail: 'Gateway connection verified.' });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const token = secret(config);
            const detail = redactText(token ? message.replaceAll(token, '[REDACTED]') : message).slice(0, 2_048);
            steps.push({ name: 'gateway-health', ok: false, detail, hint: gatewayHint(config, detail) });
          }
        }
        manager.recordDoctorResult(config.id, steps, config);
        return { id: config.id, steps };
      }),
    ),
  };
}

function gatewayHint(config: AgentConfig, detail: string): string {
  const value = detail.toLowerCase();
  if (config.kind === 'openclaw' && /pairing.required|device.approval/.test(value)) {
    return 'Approve this device in OpenClaw, then run the check again.';
  }
  if (/http 40[13]|unauthorized|token|api.key/.test(value)) {
    if (config.kind === 'hermes') return 'Enter the Hermes API server key (API_SERVER_KEY) as the gateway token.';
    if (config.kind === 'dsh') return 'Enter the launch token printed by the remote dsh web command.';
    return 'Verify the gateway token in the agent settings.';
  }
  if (/certificate|self.signed|altname|wrong version number/.test(value)) {
    return 'Check the endpoint scheme and hostname, and verify the TLS certificate is trusted.';
  }
  if (/enotfound|eai_again|could not resolve/.test(value)) {
    return 'Verify the hostname and that this device can resolve it on the private network.';
  }
  if (/timed out|timeout|econnrefused|connection refused|socket hang up/.test(value)) {
    return 'Verify the gateway is running and this device can reach the endpoint through the private network or proxy.';
  }
  if (config.acpTransport === 'stdio') return 'Check that the local command is installed and executable.';
  return 'Verify that the endpoint serves this agent protocol.';
}
