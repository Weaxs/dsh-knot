import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { AgentConfig } from '../types.js';

export function requireSecureGateway(config: AgentConfig): void {
  if (config.tls === true || config.encryptedOverlay === true) return;
  const host = config.host ?? '127.0.0.1';
  if (host.toLowerCase() === 'localhost' || (isIP(host) === 4 && host.startsWith('127.'))) return;
  if (isIP(host) === 6 && !host.includes('%')) {
    const canonical = new URL(`http://[${host}]`).hostname;
    if (canonical === '[::1]' || /^\[::ffff:7f[\da-f]{2}:[\da-f]+\]$/i.test(canonical)) return;
  }
  throw new Error(`${config.id}: gateway credentials require HTTPS/WSS, loopback, or a verified encrypted overlay`);
}

export function verifyBearerToken(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const actual = header.slice(7);
  const actualHash = createHash('sha256').update(actual).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}
