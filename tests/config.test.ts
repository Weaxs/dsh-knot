import { describe, expect, it } from 'vitest';
import { normalizeConfig } from '../src/config.js';
import { Config } from '../src/index.js';
import { redact, redactText } from '../src/policy/redact.js';

describe('configuration and policy', () => {
  it('defaults to direct and assigns protocol ports', () => {
    const value = normalizeConfig({
      agents: [
        { id: 'hermes', kind: 'hermes', host: 'gpu' },
        { id: 'claw', kind: 'openclaw', host: 'claw' },
        { id: 'remote-dsh', kind: 'dsh', host: 'dsh' },
        { id: 'acp', kind: 'acp', host: 'acp' },
      ],
    });
    expect(value.agents.map((agent) => [agent.transport, agent.port])).toEqual([
      ['direct', 8642],
      ['direct', 18789],
      ['direct', 18790],
      ['direct', 18792],
    ]);
  });

  it('keeps legacy SSH entries disabled only when loading config', () => {
    const legacy = { id: 'old', kind: 'acp', ssh: 'gpu', acpCommand: 'remote-agent', token: 'gateway-key' } as const;
    const direct = { id: 'current', kind: 'hermes', host: 'https://example.test' } as const;
    const input = Config({ agents: [legacy, direct] });
    expect(() => normalizeConfig(input)).toThrow(/SSH connections are no longer supported/);
    const normalized = normalizeConfig(input, { allowLegacySsh: true });
    expect(normalized.agents[0]).toMatchObject({ id: 'old', transport: 'ssh', token: 'gateway-key' });
    expect(normalized.agents[0]?.acpCommand).toBeUndefined();
    expect(normalized.agents[1]).toMatchObject({ id: 'current', transport: 'direct', port: 443 });
  });

  it('rejects duplicate ids, invalid ports, and direct stdio or missing endpoints', () => {
    expect(() => normalizeConfig({ agents: [{ id: 'x', kind: 'hermes' }] })).toThrow(/gateway endpoint/);
    expect(() => normalizeConfig({ agents: [{ id: 'x', kind: 'hermes', transport: 'local', port: 0 }] })).toThrow(
      /port/,
    );
    expect(() =>
      normalizeConfig({ agents: [{ id: 'x', kind: 'acp', acpTransport: 'stdio', acpCommand: 'agent' }] }),
    ).toThrow(/stdio/);
    expect(() =>
      normalizeConfig({
        agents: [
          { id: 'x', kind: 'hermes', transport: 'local' },
          { id: 'x', kind: 'hermes', transport: 'local' },
        ],
      }),
    ).toThrow(/duplicate/);
  });

  it.each(['https://user:password@example.test', 'https://example.test/?token=secret', 'wss://example.test/#fragment'])(
    'rejects non-endpoint components in %s',
    (host) => {
      expect(() => normalizeConfig({ agents: [{ id: 'x', kind: 'openclaw', host }] })).toThrow(/endpoint URL/);
    },
  );

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

  it('parses Tailscale Serve HTTPS endpoints and defaults TLS direct ports to 443', () => {
    const value = normalizeConfig({
      agents: [
        { id: 'ts-https', kind: 'hermes', transport: 'direct', host: 'https://aws-hermes.tail1234.ts.net' },
        {
          id: 'ts-prefix',
          kind: 'hermes',
          transport: 'direct',
          host: 'https://aws-hermes.tail1234.ts.net:8443/hermes/',
          port: 8642,
          tls: false,
          basePath: '/old',
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
});
