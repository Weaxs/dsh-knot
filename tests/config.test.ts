import { describe, expect, it } from 'vitest';
import { acpStdioSpawnSpec } from '../src/adapters/acp.js';
import { normalizeConfig } from '../src/config.js';
import { sshHint } from '../src/doctor.js';
import { redact, redactText } from '../src/policy/redact.js';
import { sshArguments } from '../src/transports/stdio-socket.js';

describe('configuration and policy', () => {
  it('defaults to SSH and assigns protocol ports', () => {
    const value = normalizeConfig({
      agents: [
        { id: 'hermes', kind: 'hermes', ssh: 'gpu' },
        { id: 'claw', kind: 'openclaw', ssh: 'claw' },
        { id: 'remote-dsh', kind: 'dsh', ssh: 'dsh' },
        { id: 'acp', kind: 'acp', ssh: 'acp' },
      ],
    });
    expect(value.agents.map((agent) => [agent.transport, agent.port])).toEqual([
      ['ssh', 8642],
      ['ssh', 18789],
      ['ssh', 18790],
      ['ssh', 18792],
    ]);
  });

  it('rejects duplicate ids, unsafe aliases and invalid ports', () => {
    expect(() => normalizeConfig({ agents: [{ id: 'x', kind: 'hermes', ssh: '-oProxyCommand=bad' }] })).toThrow(/ssh/);
    expect(() => normalizeConfig({ agents: [{ id: 'x', kind: 'hermes', transport: 'local', port: 0 }] })).toThrow(
      /port/,
    );
    expect(() =>
      normalizeConfig({
        agents: [{ id: 'x', kind: 'acp', transport: 'direct', acpTransport: 'stdio', acpCommand: 'agent' }],
      }),
    ).toThrow(/stdio/);
    expect(() =>
      normalizeConfig({
        agents: [
          { id: 'x', kind: 'hermes', ssh: 'a' },
          { id: 'x', kind: 'hermes', ssh: 'b' },
        ],
      }),
    ).toThrow(/duplicate/);
  });

  it('uses OpenSSH options without a shell', () => {
    const args = sshArguments({ id: 'x', kind: 'hermes', ssh: 'gpu', port: 8642 });
    expect(args).toContain('BatchMode=yes');
    expect(args).toContain('ExitOnForwardFailure=yes');
    expect(args.slice(-3)).toEqual(['-W', '127.0.0.1:8642', 'gpu']);
  });

  it('supports an explicit SSH config file for isolated E2E credentials', () => {
    const args = sshArguments({ id: 'x', kind: 'hermes', ssh: 'gpu', sshConfig: '/tmp/e2e_ssh_config', port: 8642 });
    expect(args.slice(0, 2)).toEqual(['-F', '/tmp/e2e_ssh_config']);
  });

  it('redacts credentials recursively and safely handles circular objects', () => {
    expect(redactText('Bearer abcdefghijklmnop')).toBe('[REDACTED]');
    expect(redactText('Basic dXNlcjpwYXNzd29yZA==')).toBe('[REDACTED]');
    const cyclic: Record<string, unknown> = {
      access_token: 'abc',
      nested: { text: 'Bearer abcdefghijklmnop' },
      safe: 42,
    };
    cyclic.self = cyclic;
    const value = redact(cyclic);
    expect(value.access_token).toBe('[REDACTED]');
    expect((value.nested as { text: string }).text).not.toContain('abcdefghijklmnop');
    expect(value.safe).toBe(42);
    expect(value.self).toBe('[Circular]');
  });

  it('rejects wildcard MCP hosts', () => {
    expect(() => normalizeConfig({ mcp: { enabled: true, host: '0.0.0.0' } })).toThrow(/0\.0\.0\.0/);
    expect(() => normalizeConfig({ mcp: { enabled: true, host: '::' } })).toThrow(/::/);
  });

  it('maps common SSH failures to actionable hints', () => {
    expect(sshHint('Too many authentication failures')).toMatch(/IdentitiesOnly/);
    expect(sshHint('no matching host key type found. Their offer: ssh-rsa')).toMatch(/HostKeyAlgorithms/);
    expect(sshHint('Enter passphrase for key')).toMatch(/ssh-agent/);
    expect(sshHint('sudo: a password is required')).toMatch(/acpLauncher|NOPASSWD/);
    expect(sshHint('bash: hermes: command not found')).toMatch(/PATH|runtime user/);
    expect(sshHint('socket hang up')).toMatch(/127\.0\.0\.1:8642/);
    expect(sshHint('request timed out after 15000ms')).toMatch(/443|timed out/i);
  });

  it('parses Tailscale Serve HTTPS endpoints and defaults TLS direct ports to 443', () => {
    const value = normalizeConfig({
      agents: [
        { id: 'ts-https', kind: 'hermes', transport: 'direct', host: 'https://aws-hermes.tail1234.ts.net' },
        {
          id: 'ts-prefix',
          kind: 'hermes',
          transport: 'direct',
          host: 'https://aws-hermes.tail1234.ts.net:8443/hermes/',
        },
        { id: 'tls-no-port', kind: 'hermes', transport: 'direct', host: 'aws-hermes.tail1234.ts.net', tls: true },
      ],
    });
    expect(value.agents[0]).toMatchObject({ host: 'aws-hermes.tail1234.ts.net', port: 443, tls: true });
    expect(value.agents[0]?.basePath).toBeUndefined();
    expect(value.agents[1]).toMatchObject({
      host: 'aws-hermes.tail1234.ts.net',
      port: 8443,
      tls: true,
      basePath: '/hermes',
    });
    expect(value.agents[2]).toMatchObject({ host: 'aws-hermes.tail1234.ts.net', port: 443, tls: true });
  });

  it('supports direct SSH host, port, user, and local PEM key without an ~/.ssh/config alias', () => {
    const [agent] = normalizeConfig({
      agents: [
        {
          id: 'aws-direct-ssh',
          kind: 'hermes',
          transport: 'ssh',
          sshHost: 'ec2-1-2-3-4.compute.amazonaws.com',
          sshPort: 2222,
          sshUser: 'ubuntu',
          sshIdentityFile: '/keys/aws.pem',
        },
      ],
    }).agents;
    const args = sshArguments(agent!);
    expect(args).toContain('-p');
    expect(args).toContain('2222');
    expect(args).toContain('-l');
    expect(args).toContain('ubuntu');
    expect(args).toContain('-i');
    expect(args).toContain('/keys/aws.pem');
    expect(args).toContain('IdentitiesOnly=yes');
    expect(args.slice(-3)).toEqual(['-W', '127.0.0.1:8642', 'ec2-1-2-3-4.compute.amazonaws.com']);
  });

  it('supports ACP stdio runtime user and server-approved launcher over direct SSH', () => {
    const [withRuntimeUser] = normalizeConfig({
      agents: [
        {
          id: 'aws-acp-root',
          kind: 'acp',
          transport: 'ssh',
          sshHost: '1.2.3.4',
          sshUser: 'ubuntu',
          sshIdentityFile: '/keys/aws.pem',
          acpTransport: 'stdio',
          acpCommand: '/root/.local/bin/hermes',
          acpArgs: ['acp'],
          acpRuntimeUser: 'root',
        },
      ],
    }).agents;
    const specUser = acpStdioSpawnSpec(withRuntimeUser!);
    expect(specUser.command).toBe('ssh');
    expect(specUser.args.at(-1)).toBe("'sudo' '-n' '-u' 'root' '--' '/root/.local/bin/hermes' 'acp'");

    const [withLauncher] = normalizeConfig({
      agents: [
        {
          id: 'aws-acp-launcher',
          kind: 'acp',
          transport: 'ssh',
          sshHost: '1.2.3.4',
          sshUser: 'ubuntu',
          acpTransport: 'stdio',
          acpLauncher: 'sudo -n /usr/local/bin/hermes-acp',
        },
      ],
    }).agents;
    const specLauncher = acpStdioSpawnSpec(withLauncher!);
    expect(specLauncher.args.at(-1)).toBe("'sudo' '-n' '/usr/local/bin/hermes-acp'");
  });
});
