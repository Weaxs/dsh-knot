import type { IncomingMessage } from 'node:http';

export type TransportKind = 'direct' | 'local';
export type AgentKind = 'hermes' | 'openclaw' | 'dsh' | 'acp';

export interface AgentConfig {
  id: string;
  kind: AgentKind;
  transport?: TransportKind | 'ssh'; // Legacy SSH entries remain visible for migration.
  host?: string;
  port?: number;
  tls?: boolean;
  basePath?: string;
  token?: string;
  tokenEnv?: string;
  origin?: string;
  model?: string;
  openclawAgentId?: string;
  dshProvider?: string;
  dshCwd?: string;
  reasoningEffort?: string;
  acpTransport?: 'websocket' | 'stdio';
  acpCommand?: string;
  acpArgs?: string[];
  connectTimeoutMs?: number;
}

export interface DoctorStep {
  name: string;
  ok: boolean;
  detail: string;
  hint?: string;
}

export interface AgentConnectionState {
  status: 'unverified' | 'connected' | 'error';
  checkedAt?: number;
  failedStep?: string;
  error?: string;
  hint?: string;
  steps?: DoctorStep[];
}

export interface McpConfig {
  enabled?: boolean;
  host?: string;
  port?: number;
  token?: string;
  tokenEnv?: string;
  allowSessions?: string[];
  maxEventBytes?: number;
}

export interface PluginConfig {
  agents?: AgentConfig[];
  mcp?: McpConfig;
  jobTimeoutMs?: number;
}

export interface AgentEvent {
  type: 'text' | 'tool' | 'approval' | 'final' | 'error';
  text?: string;
  name?: string;
  phase?: 'start' | 'end';
  requestId?: string;
  choices?: string[];
  stopReason?: string;
  sessionId?: string;
}

export interface AgentSession {
  id: string;
  title?: string;
  cwd?: string;
  updatedAt?: string | number;
}

export interface AgentAdapter {
  readonly id: string;
  readonly kind: AgentKind;
  health(signal?: AbortSignal): Promise<Record<string, unknown>>;
  listSessions(signal?: AbortSignal): Promise<AgentSession[]>;
  prompt(sessionId: string | undefined, text: string, signal?: AbortSignal): AsyncIterable<AgentEvent>;
  cancel(sessionId: string, signal?: AbortSignal): Promise<void>;
  respond?(sessionId: string, requestId: string, choice: string, signal?: AbortSignal): Promise<void>;
  isSessionBusy?(sessionId: string): boolean;
  close(): Promise<void>;
}

export interface HttpRequest {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
}

export interface Transport {
  readonly kind: TransportKind;
  request(request: HttpRequest): Promise<HttpResponse>;
  stream(request: HttpRequest): Promise<IncomingMessage>;
  close(): Promise<void>;
}

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface AgentJob {
  id: string;
  agentId: string;
  sessionId?: string;
  prompt?: string;
  status: JobStatus;
  createdAt: number;
  updatedAt: number;
  text: string;
  error?: string;
  pendingApproval?: { requestId: string; choices: string[]; text?: string };
}
