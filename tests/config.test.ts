import { describe, expect, it, vi } from 'vitest';
import { AcpAdapter } from '../src/adapters/acp.js';
import { DshAdapter } from '../src/adapters/dsh.js';
import { HermesAdapter } from '../src/adapters/hermes.js';
import { OpenClawAdapter } from '../src/adapters/openclaw.js';
import { normalizeConfig } from '../src/config.js';
import { requireSecureGateway } from '../src/policy/auth.js';
import { redact, redactText, redactTextSegments, retainRedactionTail, toolInputPreview } from '../src/policy/redact.js';

describe('configuration and policy', () => {
  it.each([
    ['hermes', HermesAdapter],
    ['dsh', DshAdapter],
    ['openclaw', OpenClawAdapter],
    ['acp', AcpAdapter],
  ] as const)('refuses a credential from the environment over plain LAN for %s', async (kind, Adapter) => {
    vi.stubEnv('KNOT_TEST_GATEWAY_TOKEN', 'synthetic-test-credential');
    const adapter = new Adapter('test', {
      id: 'test',
      kind,
      host: '192.0.2.5',
      transport: 'local',
      tokenEnv: 'KNOT_TEST_GATEWAY_TOKEN',
      connectTimeoutMs: 100,
    });
    try {
      await expect(adapter.health()).rejects.toThrow(/gateway credentials require HTTPS\/WSS/);
    } finally {
      vi.unstubAllEnvs();
      await adapter.close();
    }
  });

  it('accepts loopback, TLS, or a verified overlay without granting trust based on the address range', () => {
    const agent = { id: 'test', kind: 'acp' as const };
    for (const host of ['localhost', '127.9.8.7', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1']) {
      expect(() => requireSecureGateway({ ...agent, host })).not.toThrow();
    }
    expect(() => requireSecureGateway({ ...agent, host: '100.64.0.5' })).toThrow(/verified encrypted overlay/);
    expect(() => requireSecureGateway({ ...agent, host: 'fe80::1%eth0' })).toThrow(/verified encrypted overlay/);
    expect(() => requireSecureGateway({ ...agent, host: '100.64.0.5', encryptedOverlay: true })).not.toThrow();
    expect(() => requireSecureGateway({ ...agent, host: 'gateway.test', tls: true })).not.toThrow();
  });

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

  it.each([
    ['gateway.test', '/acp'],
    ['wss://gateway.test', '/acp'],
    ['wss://gateway.test/', '/'],
    ['wss://gateway.test/agent/endpoint/', '/agent/endpoint/'],
  ])('uses the ACP WebSocket path for %s', (host, basePath) => {
    const [agent] = normalizeConfig({ agents: [{ id: 'acp', kind: 'acp', host }] }).agents;
    expect(agent?.basePath).toBe(basePath);
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

  it('redacts retained fragments of a credential even if the scheme is no longer in the timeline', () => {
    expect(
      redactTextSegments(['', 'synthetic', 'marker0123456 after'], 'Before Bearer syntheticmarker0123456 after'),
    ).toEqual(['', '[REDACTED]', ' after']);
  });

  it('redacts an unfinished private key until its matching footer and keeps following content', () => {
    const header = '-----BEGIN RSA PRIVATE KEY-----';
    const partialFooter = '-----END RSA PRI';
    const marker = 'synthetic-only';
    const incomplete = `${header}\n${marker}\n-----END EC PRIVATE KEY-----\n${marker}`;
    expect(redactText(`Before ${incomplete}`)).toBe('Before [REDACTED]');
    expect(redactText(`Before ${incomplete}\n-----END RSA PRIVATE KEY-----\nAfter`)).toBe('Before [REDACTED]\nAfter');
    const context = retainRedactionTail(undefined, `${incomplete}\n${'x'.repeat(5_000)}\n${partialFooter}`);
    expect(context.suffix).toBe('');
    expect(context.shapes.get('privateKey')).toEqual([`${header}${partialFooter}`]);
    const visible = 'VATE KEY-----\nAfter';
    expect(redactTextSegments([visible], undefined, context)).toEqual(['[REDACTED]\nAfter']);
  });

  it.each([
    ['Cookie: ', 'suffix'],
    ['sk-', 'suffix'],
    ['ghp_', 'suffix'],
    ['eyJ', '.abcdefgh.abcdefgh'],
  ])('keeps bounded recognition of a long credential beginning with %s', (prefix, suffix) => {
    const context = retainRedactionTail(undefined, `${prefix}${'x'.repeat(5_000)}`);
    const retained = context.suffix + [...context.shapes.values()].flat().join('');
    expect(retained.length).toBeLessThan(64);
    expect(retained).not.toContain('x');
    const visible = `${suffix} after`;
    expect(redactTextSegments([visible], undefined, context)).toEqual(['[REDACTED] after']);
  });

  it.each([
    ['sk-abcdefghijkl-sk-', 'suffix'],
    ['eyJabcdefgh.sk-abcdefghijkl', '.abcdefgh'],
    ['eyJabcdefgh.sk-abcdefghijkl', 'suffix'],
    ['eyJshort.eyJabcdefgh.abcdefgh', '.abcdefgh'],
    ['eyJabcdefgh.abcdefgh.eyJabcdefgh', '.abcdefgh.abcdefgh'],
  ])('redacts retained text in overlapping credential shapes (%#)', (dropped, suffix) => {
    const context = retainRedactionTail(undefined, dropped);
    const visible = `${suffix} after`;
    expect(redactTextSegments([visible], undefined, context)).toEqual(['[REDACTED] after']);
  });

  it('redacts an enclosing credential even when a separate grammar matches inside it', () => {
    expect(redactText('Before eyJabcdefgh.sk-abcdefghijkl.abcdefgh after')).toBe('Before [REDACTED] after');
  });

  it('retains a divided JWT opener across evictions while another token is open', () => {
    const prefix = retainRedactionTail(undefined, 'sk-abcdefgh-ey');
    const context = retainRedactionTail(prefix, 'Jabcdefgh.abcdefgh');
    expect(redactTextSegments(['.abcdefgh after'], undefined, context)).toEqual(['[REDACTED] after']);
  });

  it('retains a new authorization opener that starts inside the previous value', () => {
    const prefix = retainRedactionTail(undefined, 'Bearer abc-Basic');
    const context = retainRedactionTail(prefix, ' ');
    expect(redactTextSegments(['syntheticvalue after'], undefined, context)).toEqual(['[REDACTED] after']);
  });

  it('bounds tool input previews and masks credentials in nested values', () => {
    const preview = toolInputPreview(
      { queries: ['architecture', 'private-value'], options: { password: { value: 'sensitive' } } },
      'private-value',
    );
    expect(JSON.parse(preview!)).toEqual({
      queries: ['architecture', '[REDACTED]'],
      options: { password: '[REDACTED]' },
    });
    expect(toolInputPreview(false)).toBe('false');
    expect(JSON.parse(toolInputPreview([0, 1, 2, 3, 4, 5, 6, 7, 8])!)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(toolInputPreview({ level1: { level2: { level3: { hidden: 'too deep' } } } })).not.toContain('too deep');
    expect(toolInputPreview('x'.repeat(600))).toHaveLength(501);
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
