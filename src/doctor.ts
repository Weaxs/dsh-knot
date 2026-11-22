import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentManager } from './manager.js';
import { shellQuote, sshConnectionFlags, sshTarget } from './transports/stdio-socket.js';
import type { AgentConfig, DoctorStep } from './types.js';

export type { DoctorStep } from './types.js';

const execute = promisify(execFile);

function combineSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

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
        let sshLoginOk = false;
        let loginUser = '';
        if ((config.transport ?? 'ssh') === 'ssh') {
          const sshOptions = sshConnectionFlags(config);
          const target = sshTarget(config);
          try {
            const { stdout } = await execute('ssh', [...sshOptions, '-G', target], {
              timeout: 10_000,
              maxBuffer: 2_000_000,
              signal,
            });
            const picked = stdout
              .split('\n')
              .filter((line) => /^(hostname|user|port|identityfile|proxycommand|proxyjump) /.test(line));
            steps.push({ name: 'ssh-config', ok: true, detail: picked.join('\n') });
          } catch (error) {
            steps.push(failure('ssh-config', error));
            manager.recordDoctorResult(config.id, steps);
            return { id: config.id, steps };
          }
          try {
            const { stdout } = await execute(
              'ssh',
              [...sshOptions, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', target, 'id', '-un'],
              {
                timeout: 15_000,
                signal,
              },
            );
            loginUser = stdout.trim() || 'unknown';
            sshLoginOk = true;
            steps.push({ name: 'ssh-login', ok: true, detail: `SSH login succeeded as "${loginUser}".` });
          } catch (error) {
            steps.push(failure('ssh-login', error));
          }
          if (sshLoginOk && config.kind === 'acp' && config.acpTransport === 'stdio') {
            steps.push(await checkAcpRuntimeOverSsh(config, sshOptions, target, loginUser, signal));
          }
        } else if (config.transport === 'direct') {
          const scheme = config.tls ? 'https' : 'http';
          const base = config.basePath ?? '';
          steps.push({
            name: 'direct-transport',
            ok: true,
            detail: `Connecting to ${scheme}://${config.host}:${config.port}${base}. Keep the gateway on loopback behind a private forward (e.g. Tailscale Serve) or a trusted interface.`,
          });
        } else {
          steps.push({
            name: 'local-transport',
            ok: true,
            detail: `Using local loopback (${config.host ?? '127.0.0.1'}:${config.port}).`,
          });
        }
        const healthSignal = combineSignal(signal, config.connectTimeoutMs ?? 15_000);
        try {
          const health = await manager.adapter(config.id).health(healthSignal);
          steps.push({ name: 'gateway-health', ok: true, detail: JSON.stringify(health) });
        } catch (error) {
          steps.push(failure('gateway-health', error));
        }
        manager.recordDoctorResult(config.id, steps);
        return { id: config.id, steps };
      }),
    ),
  };
}

async function checkAcpRuntimeOverSsh(
  config: AgentConfig,
  sshOptions: string[],
  target: string,
  loginUser: string,
  signal?: AbortSignal,
): Promise<DoctorStep> {
  const launcher = config.acpLauncher?.trim();
  const runtimeUser = config.acpRuntimeUser?.trim();
  const command = config.acpCommand?.trim();
  const baseArgs = [...sshOptions, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', target, '--'];

  if (launcher) {
    const tokens = launcher.split(/\s+/).filter(Boolean);
    const bin = tokens[0]!;
    const checkCmd =
      bin === 'sudo'
        ? `command -v sudo >/dev/null 2>&1 || { echo 'sudo not found' >&2; exit 127; }; sudo -n -l >/dev/null 2>&1 || true; printf 'login=%s launcher=%s\n' "$(id -un)" ${shellQuote(launcher)}`
        : `command -v ${shellQuote(bin)} >/dev/null 2>&1 || { echo "launcher not found: ${bin}" >&2; exit 127; }; test -x "$(command -v ${shellQuote(bin)})" || { echo "launcher not executable: ${bin}" >&2; exit 126; }; printf 'login=%s launcher=%s\n' "$(id -un)" "$(command -v ${shellQuote(bin)})"`;
    try {
      const { stdout } = await execute('ssh', [...baseArgs, checkCmd], { timeout: 15_000, signal });
      return {
        name: 'acp-runtime',
        ok: true,
        detail: `SSH login "${loginUser}" using server-approved launcher (${stdout.trim() || launcher}).`,
      };
    } catch (error) {
      return failure('acp-runtime', error);
    }
  }

  if (runtimeUser && runtimeUser !== loginUser) {
    const remoteProbe = [
      'sudo',
      '-n',
      '-u',
      runtimeUser,
      '--',
      'sh',
      '-lc',
      `printf '%s\t%s\n' "$(id -un)" "$(command -v ${shellQuote(command ?? '')})"`,
    ]
      .map(shellQuote)
      .join(' ');
    try {
      const { stdout } = await execute('ssh', [...baseArgs, remoteProbe], { timeout: 15_000, signal });
      const [actualUser, resolvedBin] = stdout.trim().split('\t');
      if (!resolvedBin) {
        return {
          name: 'acp-runtime',
          ok: false,
          detail: `SSH login "${loginUser}" switched to "${actualUser || runtimeUser}", but "${command}" was not found in PATH.`,
          hint: `Provide the absolute path to "${command}" (e.g. /root/.local/bin/hermes) or configure a server-approved acpLauncher.`,
        };
      }
      return {
        name: 'acp-runtime',
        ok: true,
        detail: `SSH login "${loginUser}" → runtime account "${actualUser || runtimeUser}" (${resolvedBin}).`,
      };
    } catch (error) {
      const step = failure('acp-runtime', error);
      return {
        ...step,
        detail: `SSH login "${loginUser}" cannot launch "${command}" as "${runtimeUser}": ${step.detail}`,
        hint: `Configure a NOPASSWD sudoers rule for a server-approved launcher, or set acpLauncher, or switch to a Tailscale Serve HTTPS endpoint.`,
      };
    }
  }

  const probe = `resolved="$(command -v ${shellQuote(command ?? '')} 2>/dev/null || true)"; if [ -z "$resolved" ]; then echo "command not found: ${command}" >&2; exit 127; fi; if [ ! -x "$resolved" ]; then echo "permission denied: $resolved" >&2; exit 126; fi; printf '%s\n' "$resolved"`;
  try {
    const { stdout } = await execute('ssh', [...baseArgs, probe], { timeout: 15_000, signal });
    return {
      name: 'acp-runtime',
      ok: true,
      detail: `Command runs as SSH login user "${loginUser}" (${stdout.trim()}).`,
    };
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    return {
      name: 'acp-runtime',
      ok: false,
      detail: `Command runs as SSH login user "${loginUser}", failed: ${raw}`,
      hint: `SSH logged in as "${loginUser}", but "${command}" is missing or not executable by this user. If Hermes was installed under root via sudo, set ACP Runtime User (e.g. root) with a server-approved launcher, or expose Hermes over Tailscale Serve HTTPS.`,
    };
  }
}

export function sshHint(text: string): string {
  const value = text.toLowerCase();
  if (value.includes('too many authentication failures'))
    return 'Set IdentitiesOnly yes and one IdentityFile for this host.';
  if (value.includes('sudo') && (value.includes('password') || value.includes('tty') || value.includes('not allowed')))
    return 'Non-interactive sudo failed. Configure a server-approved NOPASSWD launcher (acpLauncher) for the target runtime user, or use Tailscale Serve HTTPS.';
  if (value.includes('command not found') || value.includes('not found'))
    return 'The command is not in the SSH login user PATH. Check which account installed Hermes (e.g. root vs ubuntu), set the full path or ACP runtime user/launcher.';
  if (value.includes('permission denied'))
    return 'Check SSH User, IdentityFile permissions (chmod 600), authorized_keys, or binary permissions for the runtime user.';
  if (value.includes('unprotected private key')) return 'Run chmod 600 on the private key.';
  if (value.includes('invalid format') || value.includes('ppk'))
    return 'Convert a PuTTY .ppk key to OpenSSH format with puttygen.';
  if (value.includes('no matching host key type'))
    return 'For this host only, add the server-offered HostKeyAlgorithms and PubkeyAcceptedAlgorithms.';
  if (value.includes('no matching key exchange'))
    return 'For this host only, add the server-offered KexAlgorithms; plan a server upgrade.';
  if (value.includes('remote host identification has changed'))
    return 'Verify the server was reinstalled before replacing its known_hosts entry.';
  if (value.includes('host key verification failed')) return 'Connect once manually and verify the host fingerprint.';
  if (value.includes('could not resolve hostname')) return 'Check HostName, DNS, or Tailscale MagicDNS.';
  if (value.includes('socket hang up') || value.includes('open failed') || value.includes('econnrefused'))
    return 'The remote gateway closed or refused the connection. Verify Hermes API server is running on loopback (e.g. 127.0.0.1:8642) and the port matches.';
  if (value.includes('timed out') || value.includes('timeout'))
    return 'Connection timed out. Check host, port (Tailscale Serve uses HTTPS port 443), firewall/security group, and that the gateway is running.';
  if (value.includes('connection refused')) return 'Check that the service or sshd is running and the Port matches.';
  if (value.includes('passphrase'))
    return 'Add the private key to ssh-agent or the macOS keychain; background SSH cannot prompt.';
  if (value.includes('openclaw_session_token') || value.includes('openclaw_gateway_token'))
    return 'Configure the agent token in the DSH Knot Web UI (or set OPENCLAW_GATEWAY_TOKEN / tokenEnv).';
  if (value.includes('hermes_api_key'))
    return 'Configure the agent token in the DSH Knot Web UI (or set HERMES_API_KEY / tokenEnv).';
  if (value.includes('launch token') || value.includes('dsh_gateway_token'))
    return 'Paste the remote dsh web launch token into the agent token field in the DSH Knot Web UI (or DSH_GATEWAY_TOKEN).';
  return 'See docs/SSH.md. The plugin never changes ~/.ssh/config automatically.';
}

function failure(name: string, error: unknown): DoctorStep {
  const detail = error instanceof Error ? error.message : String(error);
  return { name, ok: false, detail, hint: sshHint(detail) };
}
