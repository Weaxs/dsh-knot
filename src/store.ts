import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { normalizeConfig } from './config.js';
import type { AgentConfig } from './types.js';

export interface StoredKnotState {
  agents: AgentConfig[];
  deletedIds: string[];
  allowSessions?: string[];
}

export function defaultAgentsFile(): string {
  const dir = process.env.DSH_KNOT_STATE_DIR ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'knot');
  return join(dir, 'agents.json');
}

export function loadStoredState(file = defaultAgentsFile()): StoredKnotState {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { agents: [], deletedIds: [] };
    throw new Error(`Cannot read ${file}: ${(error as Error).message}`);
  }
  const raw = JSON.parse(text) as unknown;
  if (Array.isArray(raw)) {
    return {
      agents: storedAgents(raw),
      deletedIds: [],
    };
  }
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Invalid state format in ${file}`);
  }
  const record = raw as { agents?: unknown; deletedIds?: unknown; allowSessions?: unknown };
  const agents = Array.isArray(record.agents) ? storedAgents(record.agents) : [];
  const deletedIds = Array.isArray(record.deletedIds)
    ? [...new Set(record.deletedIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0))]
    : [];
  const allowSessions = Array.isArray(record.allowSessions)
    ? [...new Set(record.allowSessions.filter((id): id is string => typeof id === 'string' && id.trim().length > 0))]
    : undefined;
  return { agents, deletedIds, ...(allowSessions !== undefined ? { allowSessions } : {}) };
}

function storedAgents(entries: unknown[]): AgentConfig[] {
  // The retired kinds have no conversion. Other saved agents and MCP state can still load.
  const agents = (entries as AgentConfig[]).filter((agent) => {
    const kind: unknown = agent?.kind;
    return kind !== 'hermes' && kind !== 'openclaw' && kind !== 'acp';
  });
  return normalizeConfig({ agents }).agents;
}

export function saveStoredState(state: StoredKnotState, file = defaultAgentsFile()): StoredKnotState {
  const normalized: StoredKnotState = {
    agents: normalizeConfig({ agents: state.agents }).agents,
    deletedIds: [...new Set(state.deletedIds.filter((id) => id && !state.agents.some((a) => a.id === id)))],
    ...(state.allowSessions !== undefined ? { allowSessions: [...new Set(state.allowSessions)] } : {}),
  };
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, file);
  return normalized;
}

export function updateStoredState(
  updater: (current: StoredKnotState) => StoredKnotState,
  file = defaultAgentsFile(),
): StoredKnotState {
  return saveStoredState(updater(loadStoredState(file)), file);
}
