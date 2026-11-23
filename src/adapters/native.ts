import { randomUUID } from 'node:crypto';
import type { AgentAdapter, AgentConfig } from '../types.js';
import { DshAdapter } from './dsh.js';
import { HermesAdapter } from './hermes.js';
import { OpenClawAdapter } from './openclaw.js';

export function createNativeAdapter(config: AgentConfig): AgentAdapter {
  if (config.kind === 'hermes') return new HermesAdapter(config.id, config);
  if (config.kind === 'openclaw') return new OpenClawAdapter(config.id, config);
  if (config.kind === 'dsh') return new DshAdapter(config.id, config);
  throw new Error(`${config.id}: native adapters are unavailable for kind ${config.kind}`);
}

export function createNativeSessionId(config: AgentConfig, id: string = randomUUID()): string {
  if (config.kind === 'hermes') return `dsh_${id}`;
  if (config.kind === 'openclaw') {
    return `agent:${config.openclawAgentId ?? 'main'}:dsh-knot:${id}`;
  }
  return id;
}
