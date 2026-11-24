import type { IncomingMessage } from 'node:http';

export type TransportKind = 'direct' | 'local';
export type AgentKind = 'hermes' | 'openclaw' | 'dsh' | 'acp';

export interface AgentConfig {
  id: string;
  kind: AgentKind;
  transport?: TransportKind;
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
  type: 'text' | 'thought' | 'tool' | 'approval' | 'final' | 'error';
  text?: string;
  interim?: boolean;
  alreadyStreamed?: boolean;
  retractText?: string;
  name?: string;
  title?: string;
  phase?: 'pending' | 'start' | 'end';
  failed?: boolean;
  inputPreview?: string;
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

export interface AgentTranscriptMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  thought?: string;
  tools?: AgentToolActivity[];
}

export interface AgentPromptOptions {
  idempotencyKey?: string;
}

export interface AgentAdapter {
  readonly id: string;
  readonly kind: AgentKind;
  health(signal?: AbortSignal): Promise<Record<string, unknown>>;
  listSessions(signal?: AbortSignal): Promise<AgentSession[]>;
  getSessionMessages?(sessionId: string, signal?: AbortSignal): Promise<AgentTranscriptMessage[]>;
  prompt(
    sessionId: string | undefined,
    text: string,
    signal?: AbortSignal,
    options?: AgentPromptOptions,
  ): AsyncIterable<AgentEvent>;
  cancel(sessionId: string, signal?: AbortSignal): Promise<void>;
  promptTerminalForCancel?(sessionId: string): Promise<unknown> | undefined;
  respond?(sessionId: string, requestId: string, choice: string, signal?: AbortSignal): Promise<void>;
  isSessionBusy?(sessionId: string): boolean;
  close(): Promise<void>;
}

export interface HttpRequest {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** Additional time the server may hold the request before sending headers. */
  responseWaitMs?: number;
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

export interface AgentToolActivity {
  id: string;
  name: string;
  title?: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'interrupted';
  inputPreview?: string;
}

export type AgentTimelineEntry =
  | { kind: 'thought'; text: string }
  | { kind: 'commentary'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; toolId: string };

export interface SessionHistoryBaseline {
  length: number;
  lastId?: string;
}

export interface AgentJob {
  id: string;
  agentId: string;
  sessionId?: string;
  prompt?: string;
  status: JobStatus;
  createdAt: number;
  updatedAt: number;
  text: string;
  thought?: string;
  tools?: AgentToolActivity[];
  timeline?: AgentTimelineEntry[];
  historyBaseline?: SessionHistoryBaseline;
  error?: string;
  remoteStop?: 'pending' | 'unconfirmed';
  pendingApproval?: { requestId: string; choices: string[]; text?: string };
}
