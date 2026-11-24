// DSH Web client entry for @weaxs/dsh-knot.
// Uses host-provided `react` (declared in peerDependencies) and DSH native `--dsw-*` tokens.
declare function require(id: string): unknown;

interface ReactModule {
  createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown;
  useState<T>(initial: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void];
  useEffect(effect: () => undefined | (() => void), deps?: readonly unknown[]): void;
  useCallback<T extends (...args: never[]) => unknown>(fn: T, deps: readonly unknown[]): T;
  useRef<T>(initial: T): { current: T };
}

interface ChatPrimitives {
  Button: unknown;
  CommandText: unknown;
  MarkdownText: unknown;
  UserMessageBubble: unknown;
}

interface ClientLocale {
  register?(ns: string, dicts: Record<string, Record<string, string>>): () => void;
  bind?(ns: string): (key: string) => string;
  current?: string;
}

interface ClientSlots {
  inject?(name: string, factory: () => () => void): () => void;
  register?(meta: Record<string, unknown>, render: (props: Record<string, unknown>) => unknown): () => void;
}

interface ClientConnection {
  fetch?(input: string, init?: RequestInit): Promise<Response>;
}

interface ClientContext {
  locale?: ClientLocale;
  slots?: ClientSlots;
  connection?: ClientConnection;
  get?(name: string): unknown;
  effect?(fn: () => (() => void) | undefined, label?: string): void;
}

interface AgentConnectionState {
  status: 'unverified' | 'connected' | 'error';
  checkedAt?: number;
  failedStep?: string;
  error?: string;
  hint?: string;
  steps?: DoctorStep[];
}

interface AgentSummary {
  id: string;
  revision: string;
  kind: 'hermes' | 'openclaw' | 'dsh' | 'acp';
  transport?: 'direct' | 'local';
  host?: string;
  basePath?: string;
  port?: number;
  tls?: boolean;
  acpTransport?: 'websocket' | 'stdio';
  acpCommand?: string;
  model?: string;
  hasToken?: boolean;
  supportsRespond?: boolean;
  supportsSessionMessages?: boolean;
  connection?: AgentConnectionState;
}

interface AgentFormState {
  editing: boolean;
  hasToken: boolean;
  clearToken: boolean;
  id: string;
  kind: 'hermes' | 'openclaw' | 'dsh' | 'acp';
  transport: 'direct' | 'local';
  endpoint: string;
  host: string;
  port: string;
  token: string;
  model: string;
  acpTransport: 'websocket' | 'stdio';
  acpCommand: string;
  acpArgsText: string;
}

type ToolStatus = 'pending' | 'running' | 'completed' | 'failed' | 'interrupted';

interface ToolActivitySummary {
  id: string;
  name: string;
  title?: string;
  status: ToolStatus;
  inputPreview?: string;
}

type TimelineEntry =
  | { kind: 'thought'; text: string }
  | { kind: 'commentary'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; toolId: string };

interface JobSummary {
  id: string;
  agentId: string;
  sessionId?: string;
  prompt?: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  createdAt: number;
  updatedAt: number;
  text: string;
  thought?: string;
  error?: string;
  remoteStop?: 'pending' | 'unconfirmed';
  pendingApproval?: { requestId: string; choices: string[]; text?: string };
  tools?: ToolActivitySummary[];
  timeline?: TimelineEntry[];
}

interface LocalSessionSummary {
  sessionId: string;
  title?: string;
  cwd?: string;
  shared: boolean;
}

interface DoctorStep {
  name: string;
  ok: boolean;
  detail: string;
  hint?: string;
}

interface KnotState {
  version: string;
  agents: AgentSummary[];
  jobs: JobSummary[];
  mcp: {
    enabled: boolean;
    address: { host: string; port: number } | null;
    allowSessions: string[];
    localSessions: LocalSessionSummary[];
  };
}

interface RemoteSessionItem {
  id: string;
  title?: string;
  updatedAt?: string | number;
}

interface TranscriptMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  thought?: string;
  tools?: ToolActivitySummary[];
}

const NS = 'dsh-knot';
const PANEL_ID = 'dsh-knot';
const STYLE_ID = 'dsh-knot-client-styles';

const DICTS: Record<string, Record<string, string>> = {
  'zh-CN': {
    title: '远端助手',
    subtitle: '直连远端 Hermes、OpenClaw、DSH 与 ACP 网关，无需云端中转。',
    replyTag: '回复',
    liveTag: '运行中',
    youTag: '你',
    localNode: '本机 dsh',
    checkAll: '检测全部连接',
    checking: '检测中…',
    refresh: '刷新',
    kpiAgents: '已验证连通',
    kpiAgentsSub: '已配置',
    kpiPending: '待你确认审批',
    kpiPendingSub: '需手动放行命令',
    kpiRunning: '后台运行任务',
    kpiRunningSub: '完成后自动通知',
    kpiShared: '已共享本地对话',
    kpiSharedSub: '只读 · 自动脱敏',
    statusConnected: '已连通',
    statusUnverified: '未检测',
    statusFailed: '连接失败',
    attentionTitle: '需要你处理与后台任务',
    attentionEmpty: '当前没有待确认的审批或运行中的后台任务。',
    wantsApproval: '请求权限确认',
    approveRemotely: '请前往远端网关确认审批',
    runningNow: '正在后台执行',
    stopTask: '停止',
    agentsHeading: '远端助手',
    agentsEmpty: '尚未配置远端助手，点击右上角「+ 添加助手」即可直接配置（推荐通过 Tailscale Serve 私网 HTTPS 转发）。',
    addAgent: '+ 添加助手',
    editAgent: '编辑',
    deleteAgent: '删除',
    confirmDeleteAgent: '确认删除?',
    saveAgent: '保存并检测',
    cancelBtn: '取消',
    modalAddTitle: '添加远端助手',
    modalEditTitle: '编辑远端助手',
    fieldId: '助手 ID',
    fieldKind: '协议类型',
    fieldTransport: '连接方式',
    transportDirectOpt: '私网 HTTPS / Tailscale Serve（推荐）',
    transportLocalOpt: '本机 Local (127.0.0.1)',
    directSetupTip: '将网关通过私网入口提供给本机，再填写完整地址和网关令牌。',
    hermesSetupTip: '在 Hermes 所在主机启用 API Server，用 Tailscale Serve 转发 8642 端口，并填写 API_SERVER_KEY。',
    openclawSetupTip: '在 OpenClaw 启用自带的 Tailscale Serve，填写 HTTPS 地址和网关令牌，首次连接时批准设备配对。',
    fieldEndpoint: '网关地址（HTTPS、HTTP 或 WebSocket）',
    fieldHost: '主机地址（IP 或 Tailscale 域名）',
    fieldPort: '本机网关端口（可选）',
    fieldToken: 'Gateway Token / API Key（独立保存，无需环境变量）',
    fieldTokenKeep: '地址不变时留空可保留令牌',
    fieldClearToken: '清空已保存的 Token',
    fieldModel: '默认模型（可选）',
    fieldAcpTransport: 'ACP 传输方式',
    fieldAcpCommand: 'ACP stdio 命令（如 hermes 或绝对路径）',
    fieldAcpArgs: 'ACP 命令参数（空格分隔，如 acp）',
    tokenConfigured: '已配密钥',
    savingAgent: '保存中…',
    savedAgentToast: '已保存配置，正在验证连接…',
    deletedAgentToast: '已移除该助手',
    chatWithAgent: '对话',
    details: '连接详情',
    retest: '重测',
    hide: '收起',
    historyHeading: '远端历史对话',
    loadingHistory: '正在加载远端会话…',
    historyErrorTitle: '加载远端历史会话失败',
    retry: '重试',
    noHistory: '该助手暂无可列出的历史会话',
    noHistoryMatch: '没有匹配的会话',
    searchPlaceholder: '搜索标题或会话 ID…',
    continuePrompt: '复制指令',
    copiedContinue: '已复制，粘贴到 dsh 主对话框即可继续',
    chatHeading: '对话',
    chatNewSession: '新建对话',
    chatEmpty: '发条消息开始对话，或从历史中选择一个会话。',
    chatPlaceholder: '给远端助手发消息…',
    chatComposerHint: 'Enter 发送 · Shift+Enter 换行',
    chatSend: '发送',
    chatSending: '发送中…',
    chatFailed: '执行失败',
    chatCancelled: '已停止',
    chatStopping: '正在停止远端任务…',
    chatStopUnconfirmed: '尚未确认远端任务已停止',
    chatBack: '助手设置',
    chatPreparing: '正在生成…',
    chatThought: '思考',
    chatToolActivity: '执行过程',
    chatToolInput: '工具参数',
    chatToolPending: '等待执行',
    chatToolRunning: '执行中',
    chatToolCompleted: '已完成',
    chatToolFailed: '失败',
    chatToolInterrupted: '已中断',
    chatHistoryError: '无法读取会话消息',
    chatHistoryLoading: '正在读取会话消息…',
    chatHistoryUnavailable: '该网关未提供历史消息读取',
    chatJobError: '无法读取任务进度',
    chatCopyError: '无法复制续聊指令',
    copiedShort: '已复制',
    closeBtn: '关闭',
    diagHeading: '连接诊断',
    shareHeading: '共享给远端的本地对话',
    shareSub: '独立只读 MCP 端口 · 默认拒绝 · 自动脱敏',
    mcpDisabled: '只读 MCP 尚未开启（可在插件设置中启用 mcp.enabled）',
    copyYaml: '复制接入配置',
    copiedYaml: '已复制 YAML',
    sharedOn: '已共享',
    sharedOff: '仅本地',
    noLocalSessions: '暂无可列出的本地会话',
  },
  en: {
    title: 'Remote Agents',
    subtitle: 'Direct links to Hermes, OpenClaw, remote dsh, and ACP gateways — no cloud relay.',
    replyTag: 'REPLY',
    liveTag: 'LIVE',
    youTag: 'YOU',
    localNode: 'local dsh',
    checkAll: 'Test all connections',
    checking: 'Testing…',
    refresh: 'Refresh',
    kpiAgents: 'Verified Connected',
    kpiAgentsSub: 'configured',
    kpiPending: 'Pending Approvals',
    kpiPendingSub: 'Manual approval required',
    kpiRunning: 'Running Jobs',
    kpiRunningSub: 'Notifies on completion',
    kpiShared: 'Shared Local Chats',
    kpiSharedSub: 'Read-only · Redacted',
    statusConnected: 'Connected',
    statusUnverified: 'Unverified',
    statusFailed: 'Failed',
    attentionTitle: 'Needs Attention & Active Jobs',
    attentionEmpty: 'No pending approvals or running remote jobs.',
    wantsApproval: 'requests approval',
    approveRemotely: 'Approve in remote gateway',
    runningNow: 'working in background',
    stopTask: 'Stop',
    agentsHeading: 'Remote Agents',
    agentsEmpty:
      'No remote agents configured yet. Click "+ Add Agent" above (Tailscale Serve private HTTPS recommended).',
    addAgent: '+ Add Agent',
    editAgent: 'Edit',
    deleteAgent: 'Remove',
    confirmDeleteAgent: 'Confirm?',
    saveAgent: 'Save & Test',
    cancelBtn: 'Cancel',
    modalAddTitle: 'Add Remote Agent',
    modalEditTitle: 'Edit Remote Agent',
    fieldId: 'Agent ID',
    fieldKind: 'Protocol',
    fieldTransport: 'Transport',
    transportDirectOpt: 'Private HTTPS / Tailscale Serve (Recommended)',
    transportLocalOpt: 'Local (127.0.0.1)',
    directSetupTip: 'Use a private gateway endpoint. Enter the full URL and gateway token below.',
    hermesSetupTip: 'Enable the Hermes API Server, forward port 8642 using Tailscale Serve, and enter API_SERVER_KEY.',
    openclawSetupTip:
      'Enable OpenClaw-managed Tailscale Serve. Enter the HTTPS URL and gateway token, then approve the first device pairing in OpenClaw.',
    fieldEndpoint: 'Gateway URL (HTTPS, HTTP, or WebSocket)',
    fieldHost: 'Host (IP or Tailscale hostname)',
    fieldPort: 'Local gateway port (optional)',
    fieldToken: 'Gateway Token / API Key (stored per agent, 0600)',
    fieldTokenKeep: 'Leave blank to keep the token for the same endpoint',
    fieldClearToken: 'Clear saved token',
    fieldModel: 'Model override (optional)',
    fieldAcpTransport: 'ACP Transport',
    fieldAcpCommand: 'ACP stdio command (e.g. hermes or full path)',
    fieldAcpArgs: 'ACP args (space-separated, e.g. acp)',
    tokenConfigured: 'Token set',
    savingAgent: 'Saving…',
    savedAgentToast: 'Agent saved — verifying connection…',
    deletedAgentToast: 'Agent removed',
    chatWithAgent: 'Chat',
    details: 'Details',
    retest: 'Retest',
    hide: 'Hide',
    historyHeading: 'Remote Conversation History',
    loadingHistory: 'Loading remote sessions…',
    historyErrorTitle: 'Failed to load remote sessions',
    retry: 'Retry',
    noHistory: 'No remote sessions returned by this agent',
    noHistoryMatch: 'No matching conversations',
    searchPlaceholder: 'Search title or session ID…',
    continuePrompt: 'Copy prompt',
    copiedContinue: 'Copied — paste into dsh main chat to continue',
    chatHeading: 'Chat',
    chatNewSession: 'New chat',
    chatEmpty: 'Send a message to start a conversation, or select one from history.',
    chatPlaceholder: 'Message remote agent…',
    chatComposerHint: 'Enter to send · Shift+Enter for newline',
    chatSend: 'Send',
    chatSending: 'Sending…',
    chatFailed: 'Failed',
    chatCancelled: 'Stopped',
    chatStopping: 'Stopping the remote run…',
    chatStopUnconfirmed: 'The remote stop has not been confirmed',
    chatBack: 'Agent settings',
    chatPreparing: 'Generating…',
    chatThought: 'Thinking',
    chatToolActivity: 'Activity',
    chatToolInput: 'Tool input',
    chatToolPending: 'Pending',
    chatToolRunning: 'Running',
    chatToolCompleted: 'Completed',
    chatToolFailed: 'Failed',
    chatToolInterrupted: 'Interrupted',
    chatHistoryError: 'Could not load conversation messages',
    chatHistoryLoading: 'Loading conversation messages…',
    chatHistoryUnavailable: 'This gateway does not support reading past messages',
    chatJobError: 'Could not load job progress',
    chatCopyError: 'Could not copy the continuation prompt',
    copiedShort: 'Copied',
    closeBtn: 'Close',
    diagHeading: 'Diagnostics',
    shareHeading: 'Local Chats Shared with Remote',
    shareSub: 'Separate read-only MCP · Deny-by-default · Auto-redacted',
    mcpDisabled: 'Read-only MCP is disabled (enable mcp.enabled in plugin settings)',
    copyYaml: 'Copy YAML',
    copiedYaml: 'Copied YAML',
    sharedOn: 'Shared',
    sharedOff: 'Private',
    noLocalSessions: 'No local sessions listed',
  },
};

const CSS = `
.dk-sidebar-icon { color: #695777; }
body[data-ds-dark-theme] .dk-sidebar-icon { color: #b6a1c4; }

.dk-root {
  --dk-canvas: var(--dsw-static-neutral-bluish-75, var(--dsw-alias-bg-layer-0, #f5f6f8));
  --dk-surface: var(--dsw-alias-bg-layer-1, #ffffff);
  --dk-fill: var(--dsw-alias-bg-layer-2, #f1f2f5);
  --dk-hover: var(--dsw-alias-interactive-bg-hover, rgba(15, 23, 42, 0.05));
  --dk-active: rgba(15, 23, 42, 0.075);
  --dk-line: var(--dsw-alias-border-l2, rgba(15, 23, 42, 0.08));
  --dk-line-fine: var(--dsw-alias-border-l3, rgba(15, 23, 42, 0.055));
  --dk-text: var(--dsw-alias-label-primary, #111827);
  --dk-text-2: var(--dsw-alias-label-secondary, #6b7280);
  --dk-text-3: var(--dsw-alias-label-tertiary, #9ca3af);
  --dk-btn-fill: var(--dsw-alias-button-primary-fill, #111827);
  --dk-btn-ink: var(--dsw-alias-label-primary-foreground, #ffffff);
  --dk-ok: #16a34a;
  --dk-warn: #d97706;
  --dk-err: #dc2626;
  --dk-shadow: var(--dsw-shadow-lv1, 0 1px 2px rgba(15, 23, 42, 0.04));
  --dk-shadow-float: 0 2px 14px rgba(15, 23, 42, 0.05), 0 1px 2px rgba(15, 23, 42, 0.04);
  --dk-mono: ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Monaco, monospace;

  height: 100%;
  overflow-y: auto;
  box-sizing: border-box;
  background: var(--dk-canvas);
  color: var(--dk-text);
  font-size: 13.5px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
body[data-ds-dark-theme] .dk-root {
  --dk-canvas: var(--dsw-alias-bg-layer-0, #111318);
  --dk-surface: var(--dsw-alias-bg-layer-1, #181b22);
  --dk-fill: var(--dsw-alias-bg-layer-2, #222631);
  --dk-hover: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.06));
  --dk-active: rgba(255, 255, 255, 0.09);
  --dk-line: var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.09));
  --dk-line-fine: var(--dsw-alias-border-l3, rgba(255, 255, 255, 0.055));
  --dk-text: var(--dsw-alias-label-primary, #eef0f4);
  --dk-text-2: var(--dsw-alias-label-secondary, #9ca3af);
  --dk-text-3: var(--dsw-alias-label-tertiary, #6b7280);
  --dk-btn-fill: var(--dsw-alias-button-primary-fill, #f3f4f6);
  --dk-btn-ink: var(--dsw-alias-label-primary-foreground, #111827);
  --dk-ok: #4ade80;
  --dk-warn: #fbbf24;
  --dk-err: #f87171;
  --dk-shadow: 0 1px 2px rgba(0, 0, 0, 0.28);
  --dk-shadow-float: 0 4px 20px rgba(0, 0, 0, 0.35);
}

.dk-root *, .dk-root *::before, .dk-root *::after { box-sizing: border-box; }
.dk-root::-webkit-scrollbar, .dk-chat-log::-webkit-scrollbar, .dk-chat-session-list::-webkit-scrollbar { width: 5px; height: 5px; }
.dk-root::-webkit-scrollbar-thumb, .dk-chat-log::-webkit-scrollbar-thumb, .dk-chat-session-list::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--dk-text) 14%, transparent);
  border-radius: 999px;
}
.dk-root::-webkit-scrollbar-track, .dk-chat-log::-webkit-scrollbar-track, .dk-chat-session-list::-webkit-scrollbar-track { background: transparent; }

.dk-mono { font-family: var(--dk-mono); }
.dk-muted { font-size: 12px; color: var(--dk-text-2); }
.dk-icon { display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
.dk-spin { animation: dk-spin 0.9s linear infinite; }
@keyframes dk-spin { to { transform: rotate(360deg); } }
@keyframes dk-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }

/* Status dots */
.dk-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; background: var(--dk-text-3); }
.dk-dot-ok { background: var(--dk-ok); }
.dk-dot-warn { background: var(--dk-warn); }
.dk-dot-err { background: var(--dk-err); }
.dk-dot-live { background: #3b82f6; animation: dk-pulse 1.3s ease-in-out infinite; }

/* Native quiet buttons */
.dk-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 30px; padding: 0 11px; border-radius: 8px; font-family: inherit;
  font-size: 12.5px; font-weight: 500; line-height: 1; white-space: nowrap;
  border: 1px solid var(--dk-line); background: var(--dk-surface); color: var(--dk-text);
  cursor: pointer; transition: background-color 0.12s ease, border-color 0.12s ease, color 0.12s ease, opacity 0.12s ease;
}
.dk-btn:hover:not(:disabled) { background: var(--dk-hover); }
.dk-btn:focus-visible { outline: 2px solid color-mix(in srgb, var(--dk-text) 30%, transparent); outline-offset: 1px; }
.dk-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.dk-btn-sm { height: 27px; padding: 0 9px; font-size: 12px; border-radius: 7px; gap: 5px; }
.dk-btn-icon { width: 28px; height: 28px; padding: 0; border-radius: 7px; }
.dk-btn-primary {
  background: var(--dk-btn-fill); color: var(--dk-btn-ink); border-color: transparent;
}
.dk-btn-primary:hover:not(:disabled) { opacity: 0.88; background: var(--dk-btn-fill); }
.dk-btn-ghost { border-color: transparent; background: transparent; color: var(--dk-text-2); }
.dk-btn-ghost:hover:not(:disabled) { background: var(--dk-hover); color: var(--dk-text); }
.dk-btn-danger { border-color: transparent; background: transparent; color: var(--dk-text-3); }
.dk-btn-danger:hover:not(:disabled) { background: color-mix(in srgb, var(--dk-err) 10%, transparent); color: var(--dk-err); }
.dk-btn-danger-armed {
  background: color-mix(in srgb, var(--dk-err) 12%, transparent);
  border-color: color-mix(in srgb, var(--dk-err) 30%, transparent);
  color: var(--dk-err);
}

/* ==================== DASHBOARD (CALM GROUPED SETTINGS) ==================== */
.dk-page { padding: 28px 32px 48px; }
.dk-wrap { max-width: 860px; margin: 0 auto; display: flex; flex-direction: column; gap: 20px; }

.dk-topbar {
  display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap;
}
.dk-topbar-left { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.dk-title { font-size: 18px; font-weight: 600; letter-spacing: -0.015em; margin: 0; color: var(--dk-text); }
.dk-summary-inline {
  display: inline-flex; align-items: center; gap: 10px; font-size: 12.5px; color: var(--dk-text-2);
}
.dk-summary-item { display: inline-flex; align-items: center; gap: 5px; }
.dk-summary-warn { color: var(--dk-warn); font-weight: 500; }
.dk-topbar-right { display: flex; align-items: center; gap: 6px; }

.dk-group-head {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 0 4px 8px;
}
.dk-group-label { font-size: 12px; font-weight: 500; color: var(--dk-text-2); }

/* Grouped List Surface */
.dk-list {
  background: var(--dk-surface);
  border: 1px solid var(--dk-line);
  border-radius: 12px;
  box-shadow: var(--dk-shadow);
  overflow: hidden;
}
.dk-agent-row {
  border-bottom: 1px solid var(--dk-line-fine);
  transition: background-color 0.12s ease;
}
.dk-agent-row:last-child { border-bottom: 0; }
.dk-agent-main {
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  padding: 15px 18px;
}
.dk-agent-left { display: flex; align-items: flex-start; gap: 12px; min-width: 0; flex: 1; }
.dk-agent-dot-wrap { display: inline-flex; align-items: center; padding-top: 7px; flex-shrink: 0; }
.dk-agent-info { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px; }
.dk-agent-title-line { display: flex; align-items: center; gap: 8px; min-width: 0; flex-wrap: wrap; }
.dk-agent-name { font-size: 14px; font-weight: 600; color: var(--dk-text); }
.dk-agent-kind {
  font-size: 11px; color: var(--dk-text-2); background: var(--dk-fill);
  padding: 1px 6px; border-radius: 5px;
}
.dk-agent-key { display: inline-flex; align-items: center; color: var(--dk-text-3); }
.dk-agent-sub {
  font-size: 12px; color: var(--dk-text-2);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dk-agent-actions { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
.dk-agent-actions .dk-btn-chat-go { margin-left: 6px; }

/* Inline expanded diagnostics */
.dk-diag {
  padding: 10px 18px 14px 37px;
  border-top: 1px solid var(--dk-line-fine);
  background: color-mix(in srgb, var(--dk-fill) 45%, var(--dk-surface));
  display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 18px; align-items: baseline;
}
.dk-diag-step {
  display: inline-flex; align-items: center; gap: 6px; white-space: nowrap;
  font-size: 12px; font-weight: 500;
}
.dk-diag-ok { color: var(--dk-ok); }
.dk-diag-err { color: var(--dk-err); }
.dk-diag-detail { font-size: 12px; color: var(--dk-text-2); overflow-wrap: anywhere; }
.dk-diag-hint { grid-column: 1 / -1; padding-left: 19px; font-size: 11.5px; color: var(--dk-text-2); }

.dk-row-err {
  margin: 0 18px 14px 37px; padding: 8px 11px; border-radius: 8px; font-size: 12px;
  background: color-mix(in srgb, var(--dk-err) 7%, transparent);
  color: var(--dk-err); display: flex; flex-direction: column; gap: 3px;
}

/* Active jobs / approvals */
.dk-job-row {
  padding: 13px 18px; border-bottom: 1px solid var(--dk-line-fine);
  display: flex; flex-direction: column; gap: 8px;
}
.dk-job-row:last-child { border-bottom: 0; }
.dk-job-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.dk-pre {
  margin: 0; padding: 9px 11px; border-radius: 8px;
  background: var(--dk-fill); font-size: 12px; color: var(--dk-text);
  overflow-x: auto; white-space: pre-wrap; word-break: break-word;
}

/* MCP Share */
.dk-mcp-footnote {
  display: flex; align-items: center; gap: 8px; padding: 2px 4px;
  font-size: 12px; color: var(--dk-text-3);
}
.dk-mcp-row {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 12px 18px; border-bottom: 1px solid var(--dk-line-fine);
}
.dk-mcp-row:last-child { border-bottom: 0; }
.dk-switch {
  display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px;
  font-size: 12px; font-weight: 500; border: 0; cursor: pointer; font-family: inherit;
  transition: background-color 0.14s ease, color 0.14s ease;
}
.dk-switch.is-on { background: color-mix(in srgb, var(--dk-ok) 13%, transparent); color: var(--dk-ok); }
.dk-switch.is-off { background: var(--dk-fill); color: var(--dk-text-2); }

.dk-empty {
  padding: 40px 24px; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 12px;
  color: var(--dk-text-2); font-size: 13px;
}

.dk-errbox {
  background: color-mix(in srgb, var(--dk-err) 8%, var(--dk-surface));
  border: 1px solid color-mix(in srgb, var(--dk-err) 22%, transparent);
  border-radius: 10px; padding: 10px 13px; color: var(--dk-err); font-size: 12.5px;
  display: flex; flex-direction: column; gap: 6px;
}
.dk-warnbox {
  background: color-mix(in srgb, var(--dk-warn) 8%, var(--dk-surface));
  border: 1px solid color-mix(in srgb, var(--dk-warn) 26%, transparent);
  border-radius: 10px; padding: 12px 14px; display: flex; flex-direction: column; gap: 8px;
}
.dk-infobox {
  background: var(--dk-fill); border-radius: 8px; padding: 9px 12px;
  font-size: 12px; color: var(--dk-text-2); line-height: 1.5;
}

/* Inputs & Modal */
.dk-input {
  width: 100%; height: 34px; padding: 0 11px; border-radius: 8px; font-size: 13px; font-family: inherit;
  border: 1px solid var(--dk-line); background: var(--dk-surface); color: var(--dk-text); outline: none;
  transition: border-color 0.14s ease;
}
.dk-input:focus { border-color: color-mix(in srgb, var(--dk-text) 45%, transparent); }
.dk-input:disabled { opacity: 0.55; background: var(--dk-fill); cursor: not-allowed; }
.dk-modal-bg {
  position: fixed; inset: 0; z-index: 9990;
  background: rgba(0, 0, 0, 0.36); backdrop-filter: blur(4px);
  display: flex; align-items: center; justify-content: center; padding: 20px;
}
.dk-modal {
  width: 100%; max-width: 500px; max-height: 88vh; overflow-y: auto;
  background: var(--dk-surface); border: 1px solid var(--dk-line); border-radius: 14px;
  padding: 20px 22px; box-shadow: 0 18px 48px rgba(0, 0, 0, 0.22);
  display: flex; flex-direction: column; gap: 14px;
}
.dk-modal-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.dk-modal-title { font-size: 15px; font-weight: 600; margin: 0; }
.dk-modal-foot { display: flex; justify-content: flex-end; gap: 8px; padding-top: 6px; }
.dk-field { display: flex; flex-direction: column; gap: 5px; font-size: 12px; font-weight: 500; color: var(--dk-text-2); }
.dk-field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }

.dk-toast {
  position: fixed; top: 16px; left: 50%; transform: translateX(-50%); z-index: 9999;
  padding: 7px 14px; border-radius: 999px; font-size: 12.5px; font-weight: 500;
  background: var(--dk-btn-fill); color: var(--dk-btn-ink); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
}

/* ==================== NATIVE TWO-PANE CHAT ==================== */
.dk-chat-page {
  display: grid;
  grid-template-columns: 256px minmax(0, 1fr);
  height: 100%;
  overflow: hidden;
  background: var(--dk-surface);
}

/* Left Rail */
.dk-chat-rail {
  min-height: 0;
  background: var(--dk-canvas);
  border-right: 1px solid var(--dk-line);
  display: flex; flex-direction: column; overflow: hidden;
}
.dk-rail-top {
  height: 48px; padding: 0 10px;
  display: flex; align-items: center; justify-content: space-between; gap: 6px;
  flex-shrink: 0;
}
.dk-rail-controls {
  padding: 0 10px 10px; display: flex; flex-direction: column; gap: 8px; flex-shrink: 0;
}
.dk-agent-pick {
  display: flex; align-items: center; gap: 8px; height: 32px; padding: 0 10px;
  border-radius: 8px; background: var(--dk-surface); border: 1px solid var(--dk-line);
}
.dk-agent-pick select {
  flex: 1; min-width: 0; border: 0; background: transparent; color: var(--dk-text);
  font-size: 12.5px; font-weight: 600; font-family: inherit; outline: none; cursor: pointer;
}
.dk-search-row { display: flex; align-items: center; gap: 4px; }
.dk-search-wrap { position: relative; flex: 1; min-width: 0; display: flex; align-items: center; }
.dk-search-icon {
  position: absolute; left: 9px; color: var(--dk-text-3); pointer-events: none;
  display: inline-flex; align-items: center;
}
.dk-search-input {
  width: 100%; height: 30px; padding: 0 8px 0 28px; border-radius: 8px; font-size: 12px; font-family: inherit;
  border: 1px solid transparent; background: var(--dk-hover); color: var(--dk-text); outline: none;
  transition: background-color 0.14s ease, border-color 0.14s ease;
}
.dk-search-input:focus { background: var(--dk-surface); border-color: var(--dk-line); }
.dk-search-input::placeholder { color: var(--dk-text-3); }

.dk-chat-session-list {
  flex: 1; min-height: 0; overflow-y: auto; padding: 2px 8px 12px;
  display: flex; flex-direction: column; gap: 2px;
}
.dk-chat-session {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  width: 100%; text-align: left; font-family: inherit;
  padding: 8px 10px; border-radius: 8px; border: 0;
  background: transparent; color: var(--dk-text-2); cursor: pointer;
  transition: background-color 0.1s ease, color 0.1s ease;
}
.dk-chat-session:hover { background: var(--dk-hover); color: var(--dk-text); }
.dk-chat-session[aria-current="true"] { background: var(--dk-active); color: var(--dk-text); }
.dk-chat-session-title {
  font-size: 13px; font-weight: 400; line-height: 1.35; min-width: 0; flex: 1;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dk-chat-session[aria-current="true"] .dk-chat-session-title { font-weight: 500; }
.dk-chat-session-time {
  font-size: 11px; color: var(--dk-text-3); flex-shrink: 0; font-variant-numeric: tabular-nums;
}
.dk-sessions-empty { padding: 24px 12px; text-align: center; font-size: 12px; color: var(--dk-text-3); }

/* Right Thread Pane */
.dk-chat-thread {
  display: grid; grid-template-rows: 48px minmax(0, 1fr) auto;
  min-width: 0; min-height: 0; background: var(--dk-surface);
}
.dk-chat-thread-header {
  height: 48px; padding: 0 22px;
  border-bottom: 1px solid var(--dk-line-fine);
  display: flex; align-items: center; justify-content: space-between; gap: 14px;
}
.dk-chat-thread-left { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.dk-chat-thread-header h2 {
  margin: 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 14px; font-weight: 600; color: var(--dk-text);
}
.dk-chat-thread-agent { font-size: 12px; color: var(--dk-text-3); flex-shrink: 0; }

.dk-chat-log { min-height: 0; overflow-y: auto; display: flex; flex-direction: column; }
.dk-chat-messages {
  display: flex; flex-direction: column; gap: 24px;
  width: 100%; max-width: 720px; margin: 0 auto;
  padding: 28px 24px 36px; flex: 1;
}
.dk-chat-welcome {
  margin: auto; padding: 40px 20px; text-align: center; max-width: 380px;
  display: flex; flex-direction: column; align-items: center; gap: 8px;
}
.dk-chat-welcome-mark {
  width: 40px; height: 40px; border-radius: 50%; background: var(--dk-fill);
  color: var(--dk-text-2); display: inline-flex; align-items: center; justify-content: center;
  margin-bottom: 4px;
}
.dk-chat-welcome-title { font-size: 16px; font-weight: 600; color: var(--dk-text); }

/* Messages: calm, borderless, native */
.dk-chat-user {
  align-self: flex-end; max-width: 78%;
  white-space: pre-wrap; overflow-wrap: anywhere;
  font-size: 14px; line-height: 1.62;
  border-radius: 18px !important;
}
.dk-chat-turn { display: flex; flex-direction: column; gap: 20px; min-width: 0; overflow-wrap: anywhere; }
.dk-chat-assistant {
  display: grid; grid-template-columns: 26px minmax(0, 1fr); gap: 12px; align-items: start;
}
.dk-chat-mark {
  width: 24px; height: 24px; border-radius: 50%; margin-top: 1px;
  background: var(--dk-fill); color: var(--dk-text-2);
  display: inline-flex; align-items: center; justify-content: center;
}
.dk-chat-assistant-body {
  min-width: 0; display: flex; flex-direction: column; gap: 10px;
  font-size: 14px; line-height: 1.72; color: var(--dk-text);
}
.dk-chat-markdown > :first-child { margin-top: 0; }
.dk-chat-markdown > :last-child { margin-bottom: 0; }

/* Quiet inline Thought & Tool disclosure */
.dk-chat-activity { font-size: 12.5px; color: var(--dk-text-2); }
.dk-chat-activity summary {
  list-style: none; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;
  padding: 2px 0; user-select: none; color: var(--dk-text-2);
  transition: color 0.12s ease;
}
.dk-chat-activity summary::-webkit-details-marker { display: none; }
.dk-chat-activity summary:hover { color: var(--dk-text); }
.dk-chat-activity-chevron { transition: transform 0.14s ease; color: var(--dk-text-3); }
.dk-chat-activity[open] .dk-chat-activity-chevron { transform: rotate(90deg); }
.dk-chat-thought {
  margin: 6px 0 2px 5px; padding-left: 12px;
  border-left: 1.5px solid var(--dk-line);
  font-size: 12.5px; line-height: 1.62; color: var(--dk-text-2);
}
.dk-chat-activity ul {
  list-style: none; margin: 6px 0 2px 5px; padding: 0 0 0 12px;
  border-left: 1.5px solid var(--dk-line);
  display: flex; flex-direction: column; gap: 8px;
}
.dk-chat-activity li {
  display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: baseline; gap: 4px 12px;
}
.dk-chat-activity-name { color: var(--dk-text); font-weight: 500; font-size: 12px; }
.dk-chat-activity-state { font-size: 11.5px; color: var(--dk-text-3); }
.dk-chat-activity-state.is-ok { color: var(--dk-ok); }
.dk-chat-activity-state.is-err { color: var(--dk-err); }
.dk-chat-activity-state.is-run { color: var(--dk-warn); }
.dk-chat-activity-input { grid-column: 1 / -1; min-width: 0; }

.dk-chat-status {
  display: inline-flex; align-items: center; gap: 10px; align-self: flex-start;
  font-size: 12.5px; color: var(--dk-text-2);
}

/* Floating Pill/Rounded Composer */
.dk-chat-form { width: 100%; padding: 4px 24px 18px; background: var(--dk-surface); }
.dk-chat-form-inner { max-width: 720px; margin: 0 auto; display: flex; flex-direction: column; gap: 8px; }
.dk-chat-composer-box {
  background: var(--dk-surface);
  border: 1px solid var(--dk-line);
  border-radius: 20px;
  box-shadow: var(--dk-shadow-float);
  display: flex; flex-direction: column;
  transition: border-color 0.15s ease;
}
.dk-chat-composer-box:focus-within { border-color: color-mix(in srgb, var(--dk-text) 28%, transparent); }
.dk-chat-textarea {
  width: 100%; min-height: 44px; max-height: 160px; resize: none;
  padding: 13px 16px 4px; border: 0; background: transparent; color: var(--dk-text);
  font-size: 14px; line-height: 1.55; font-family: inherit; outline: none;
}
.dk-chat-textarea::placeholder { color: var(--dk-text-3); }
.dk-chat-composer-bar {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 4px 10px 9px 16px;
}
.dk-chat-hint { font-size: 11.5px; color: var(--dk-text-3); }
.dk-send-circle {
  width: 30px; height: 30px; border-radius: 50%; border: 0; padding: 0;
  background: var(--dk-btn-fill); color: var(--dk-btn-ink);
  display: inline-flex; align-items: center; justify-content: center;
  cursor: pointer; flex-shrink: 0; transition: opacity 0.14s ease, transform 0.12s ease;
}
.dk-send-circle:hover:not(:disabled) { opacity: 0.85; }
.dk-send-circle:active:not(:disabled) { transform: scale(0.95); }
.dk-send-circle:disabled { opacity: 0.28; cursor: not-allowed; }

@media (max-width: 760px) {
  .dk-page { padding: 18px 16px 32px; }
  .dk-agent-main { flex-direction: column; align-items: flex-start; gap: 10px; }
  .dk-chat-page { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
  .dk-chat-rail { max-height: 180px; border-right: 0; border-bottom: 1px solid var(--dk-line); }
  .dk-chat-messages { padding: 18px 16px 24px; }
  .dk-chat-form { padding: 4px 14px 14px; }
  .dk-field-row { grid-template-columns: 1fr; }
}
`;

function injectStyles(): () => void {
  if (typeof document === 'undefined') return () => {};
  let el = document.getElementById(STYLE_ID);
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  el.textContent = CSS;
  return () => {
    document.getElementById(STYLE_ID)?.remove();
  };
}

function formatSessionTime(value: string | number | undefined, lang: Language): string {
  if (value === undefined || value === null || value === '') return '';
  let ms = typeof value === 'number' ? value : Number(value);
  if (Number.isFinite(ms)) {
    if (ms > 0 && ms < 1e12) ms *= 1000;
  } else {
    ms = Date.parse(String(value));
  }
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const diffSec = Math.floor((Date.now() - ms) / 1000);
  if (diffSec >= 0 && diffSec < 60) return lang === 'zh-CN' ? '刚刚' : 'now';
  if (diffSec >= 60 && diffSec < 3600) {
    const mins = Math.floor(diffSec / 60);
    return lang === 'zh-CN' ? `${mins}分钟前` : `${mins}m`;
  }
  if (diffSec >= 3600 && diffSec < 86_400) {
    const hrs = Math.floor(diffSec / 3600);
    return lang === 'zh-CN' ? `${hrs}小时前` : `${hrs}h`;
  }
  const date = new Date(ms);
  const now = new Date();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return date.getFullYear() === now.getFullYear() ? `${mm}-${dd}` : `${date.getFullYear()}-${mm}-${dd}`;
}

function makeIcons(React: ReactModule) {
  const h = React.createElement;
  const svg = (paths: unknown[], size = 14, className = '') =>
    h(
      'svg',
      {
        xmlns: 'http://www.w3.org/2000/svg',
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: '1.8',
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        className: className ? `dk-icon ${className}` : 'dk-icon',
        'aria-hidden': true,
      },
      ...paths,
    );
  return {
    refresh: (spin = false, size = 13) =>
      svg(
        [h('path', { key: 'a', d: 'M21 12a9 9 0 1 1-2.64-6.36' }), h('path', { key: 'b', d: 'M21 3v6h-6' })],
        size,
        spin ? 'dk-spin' : '',
      ),
    plus: (size = 14) => svg([h('path', { key: 'a', d: 'M12 5v14' }), h('path', { key: 'b', d: 'M5 12h14' })], size),
    chat: (size = 14) =>
      svg(
        [
          h('path', {
            key: 'a',
            d: 'M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z',
          }),
        ],
        size,
      ),
    edit: (size = 13) => svg([h('path', { key: 'a', d: 'M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z' })], size),
    trash: (size = 13) =>
      svg(
        [
          h('path', { key: 'a', d: 'M3 6h18' }),
          h('path', { key: 'b', d: 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6' }),
          h('path', { key: 'c', d: 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' }),
        ],
        size,
      ),
    chevronRight: (size = 13, className = '') => svg([h('path', { key: 'a', d: 'm9 18 6-6-6-6' })], size, className),
    chevronDown: (size = 13, rotated = false) =>
      svg([h('path', { key: 'a', d: rotated ? 'm18 15-6-6-6 6' : 'm6 9 6 6 6-6' })], size),
    check: (size = 13) => svg([h('path', { key: 'a', d: 'M20 6 9 17l-5-5' })], size),
    alert: (size = 13) =>
      svg(
        [
          h('circle', { key: 'a', cx: '12', cy: '12', r: '9' }),
          h('path', { key: 'b', d: 'M12 8v4' }),
          h('path', { key: 'c', d: 'M12 16h.01' }),
        ],
        size,
      ),
    key: (size = 11) =>
      svg(
        [
          h('circle', { key: 'a', cx: '7.5', cy: '15.5', r: '4.5' }),
          h('path', { key: 'b', d: 'm21 2-9.6 9.6' }),
          h('path', { key: 'c', d: 'm15.5 7.5 3 3L22 7l-3-3' }),
        ],
        size,
      ),
    copy: (size = 13) =>
      svg(
        [
          h('rect', { key: 'a', width: '13', height: '13', x: '9', y: '9', rx: '2' }),
          h('path', { key: 'b', d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' }),
        ],
        size,
      ),
    search: (size = 13) =>
      svg([h('circle', { key: 'a', cx: '11', cy: '11', r: '7' }), h('path', { key: 'b', d: 'm20 20-3.5-3.5' })], size),
    arrowLeft: (size = 14) =>
      svg([h('path', { key: 'a', d: 'M19 12H5' }), h('path', { key: 'b', d: 'm12 19-7-7 7-7' })], size),
    arrowUpRight: (size = 13) =>
      svg([h('path', { key: 'a', d: 'M7 17 17 7' }), h('path', { key: 'b', d: 'M7 7h10v10' })], size),
    send: (size = 13) =>
      svg([h('path', { key: 'a', d: 'M12 19V5' }), h('path', { key: 'b', d: 'm5 12 7-7 7 7' })], size),
    stop: (size = 12) => svg([h('rect', { key: 'a', x: '5', y: '5', width: '14', height: '14', rx: '2' })], size),
    sparkles: (size = 13) =>
      svg([h('path', { key: 'a', d: 'M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2z' })], size),
    terminal: (size = 13) =>
      svg([h('path', { key: 'a', d: 'm4 17 6-6-6-6' }), h('path', { key: 'b', d: 'M12 19h8' })], size),
    shield: (size = 14) => svg([h('path', { key: 'a', d: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z' })], size),
    knot: (size = 13) =>
      svg(
        [
          h('path', {
            key: 'a',
            d: 'M7.4 13.5H6a3 3 0 0 1-3-3v-2a3 3 0 0 1 3-3h5.5a3 3 0 0 1 3 3v2a3 3 0 0 1-2.9 3M12.4 10.5a3 3 0 0 0-2.9 3v2a3 3 0 0 0 3 3H18a3 3 0 0 0 3-3v-2a3 3 0 0 0-3-3h-1.4',
          }),
        ],
        size,
      ),
    close: (size = 15) =>
      svg([h('path', { key: 'a', d: 'M18 6 6 18' }), h('path', { key: 'b', d: 'm6 6 12 12' })], size),
  };
}

function getClientService<T>(ctx: ClientContext, key: 'locale' | 'slots' | 'connection'): T | undefined {
  if (typeof ctx.get === 'function') return ctx.get(key) as T | undefined;
  return ctx[key] as T | undefined;
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function apiPost<T>(
  ctx: ClientContext,
  path: string,
  body: Record<string, unknown> = {},
  timeoutMs?: number,
  abortSignal?: AbortSignal,
): Promise<T> {
  const conn = getClientService<ClientConnection>(ctx, 'connection');
  const fetcher = typeof conn?.fetch === 'function' ? conn.fetch.bind(conn) : fetch;
  const controller = timeoutMs && typeof AbortController !== 'undefined' ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  const signal =
    controller && abortSignal ? AbortSignal.any([controller.signal, abortSignal]) : (controller?.signal ?? abortSignal);
  try {
    const response = await fetcher(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    const payload = (await response.json().catch((error) => {
      if (response.ok) throw error;
      return {};
    })) as { ok?: boolean; value?: T; error?: string };
    if (!response.ok || payload.ok === false)
      throw new ApiError(response.status, payload.error ?? `HTTP ${response.status}`);
    return payload.value as T;
  } catch (err) {
    if (controller?.signal.aborted) {
      throw new Error(`Request timed out after ${Math.round((timeoutMs ?? 20_000) / 1000)}s`);
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function defaultPortForKind(kind: AgentFormState['kind']): string {
  return kind === 'openclaw' ? '18789' : kind === 'dsh' ? '18790' : kind === 'acp' ? '18792' : '8642';
}

function formatDirectEndpoint(agent: AgentSummary): string {
  const scheme = agent.tls ? 'https' : 'http';
  const hostname = agent.host ?? '127.0.0.1';
  const host = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
  const port = agent.port;
  const omitPort = (agent.tls && port === 443) || (!agent.tls && port === 80) || !port;
  return `${scheme}://${host}${omitPort ? '' : `:${port}`}${agent.basePath ?? ''}`;
}

type Language = 'zh-CN' | 'en';
type Translate = (key: string) => string;

const MARKDOWN_LABELS = {
  'zh-CN': { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' },
  en: { code: { copyLabel: 'Copy', copiedLabel: 'Copied' }, footnotes: 'Footnotes' },
};

const TOOL_STATUS_LABEL: Record<ToolStatus, string> = {
  pending: 'chatToolPending',
  running: 'chatToolRunning',
  completed: 'chatToolCompleted',
  failed: 'chatToolFailed',
  interrupted: 'chatToolInterrupted',
};

function isRunning(job?: JobSummary): boolean {
  return job?.status === 'queued' || job?.status === 'running' || job?.remoteStop !== undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ChatProps {
  agent: AgentSummary;
  agents: AgentSummary[];
  jobs: JobSummary[];
  lang: Language;
  t: Translate;
  onAgentChange: (id: string) => void;
  onClose: () => void;
  refreshState: () => Promise<void>;
}

function makeRemoteChat(React: ReactModule, ctx: ClientContext, primitives: ChatPrimitives) {
  const h = React.createElement;
  const icons = makeIcons(React);
  const Thread = makeChatThread(React, ctx, primitives);
  const draftKeys = new Map<string, number>();
  let nextThreadKey = 0;

  return function RemoteChat({ agent, agents, jobs, lang, t, onAgentChange, onClose, refreshState }: ChatProps) {
    const [sessions, setSessions] = React.useState<RemoteSessionItem[] | null>(null);
    const [loadingSessions, setLoadingSessions] = React.useState(false);
    const [sessionError, setSessionError] = React.useState('');
    const [search, setSearch] = React.useState('');
    const [thread, setThread] = React.useState(() => ({ key: draftKeys.get(agent.revision) ?? 0, id: '' }));
    const [shownSessionId, setShownSessionId] = React.useState('');
    const [refreshCount, setRefreshCount] = React.useState(0);

    const reloadSessions = React.useCallback(() => setRefreshCount((count) => count + 1), []);

    React.useEffect(() => {
      const controller = new AbortController();
      setSessionError('');
      setLoadingSessions(true);
      void apiPost<{ sessions: RemoteSessionItem[] }>(
        ctx,
        '/api/dsh-knot/sessions',
        { agentId: agent.id, revision: agent.revision },
        20_000,
        controller.signal,
      )
        .then(({ sessions: items }) => {
          if (!controller.signal.aborted) setSessions(items);
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) setSessionError(errorMessage(error));
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoadingSessions(false);
        });
      return () => controller.abort();
    }, [agent.id, agent.revision, refreshCount]);

    const openThread = (id = '') => {
      const key = ++nextThreadKey;
      if (!id) {
        draftKeys.delete(agent.revision);
        draftKeys.set(agent.revision, key);
        if (draftKeys.size > 100) {
          const oldest = draftKeys.keys().next().value;
          if (oldest !== undefined) draftKeys.delete(oldest);
        }
      }
      setShownSessionId(id);
      setThread({ key, id });
    };
    const query = search.trim().toLowerCase();
    const matches = sessions?.filter(
      (item) => item.id.toLowerCase().includes(query) || item.title?.toLowerCase().includes(query),
    );
    const title = sessions?.find((item) => item.id === shownSessionId)?.title;
    const connStatus = agent.connection?.status ?? 'unverified';
    const dotClass =
      connStatus === 'connected' ? 'dk-dot dk-dot-ok' : connStatus === 'error' ? 'dk-dot dk-dot-err' : 'dk-dot';

    return h(
      'div',
      { className: 'dk-root dk-chat-page' },
      h(
        'aside',
        { className: 'dk-chat-rail', 'aria-label': t('historyHeading') },
        h(
          'div',
          { className: 'dk-rail-top' },
          h(
            'button',
            { type: 'button', className: 'dk-btn dk-btn-sm dk-btn-ghost', onClick: onClose },
            icons.arrowLeft(14),
            t('chatBack'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dk-btn dk-btn-icon dk-btn-ghost',
              title: t('chatNewSession'),
              'aria-label': t('chatNewSession'),
              onClick: () => openThread(),
            },
            icons.plus(15),
          ),
        ),
        h(
          'div',
          { className: 'dk-rail-controls' },
          h(
            'div',
            { className: 'dk-agent-pick' },
            h('span', { className: dotClass, 'aria-hidden': true }),
            h(
              'select',
              {
                'aria-label': t('agentsHeading'),
                value: agent.id,
                onChange: (event: { target: HTMLSelectElement }) => onAgentChange(event.target.value),
              },
              agents.map((item) => h('option', { key: item.id, value: item.id }, item.id)),
            ),
            h('span', { className: 'dk-agent-kind dk-mono' }, agent.kind),
          ),
          h(
            'div',
            { className: 'dk-search-row' },
            h(
              'div',
              { className: 'dk-search-wrap' },
              h('span', { className: 'dk-search-icon' }, icons.search(13)),
              h('input', {
                className: 'dk-search-input',
                type: 'search',
                'aria-label': t('searchPlaceholder'),
                value: search,
                placeholder: t('searchPlaceholder'),
                onInput: (event: { target: HTMLInputElement }) => setSearch(event.target.value),
              }),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dk-btn dk-btn-icon dk-btn-ghost',
                title: t('refresh'),
                'aria-label': t('refresh'),
                disabled: loadingSessions,
                onClick: reloadSessions,
              },
              icons.refresh(loadingSessions, 12),
            ),
          ),
        ),
        h(
          'div',
          { className: 'dk-chat-session-list' },
          sessionError
            ? h(
                'div',
                { className: 'dk-errbox', role: 'alert', style: { margin: '4px 2px 8px' } },
                h('span', null, `${t('historyErrorTitle')}: ${sessionError}`),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dk-btn dk-btn-sm',
                    style: { alignSelf: 'flex-start' },
                    onClick: reloadSessions,
                  },
                  t('retry'),
                ),
              )
            : null,
          matches?.length
            ? matches.map((item) => {
                const relTime = formatSessionTime(item.updatedAt, lang);
                return h(
                  'button',
                  {
                    key: item.id,
                    type: 'button',
                    className: 'dk-chat-session',
                    'aria-current': shownSessionId === item.id ? 'true' : undefined,
                    title: item.title ? `${item.title} (${item.id})` : item.id,
                    onClick: () => {
                      if (shownSessionId !== item.id) openThread(item.id);
                    },
                  },
                  h('span', { className: 'dk-chat-session-title' }, item.title || item.id),
                  relTime ? h('span', { className: 'dk-chat-session-time' }, relTime) : null,
                );
              })
            : !sessionError
              ? h(
                  'div',
                  { className: 'dk-sessions-empty', role: 'status' },
                  t(!sessions ? 'loadingHistory' : query ? 'noHistoryMatch' : 'noHistory'),
                )
              : null,
        ),
      ),
      h(Thread, {
        key: thread.key,
        agent,
        jobs,
        session: thread.id,
        draftKey: thread.key,
        title,
        lang,
        t,
        onSession: setShownSessionId,
        reloadSessions,
        refreshState,
      }),
    );
  };
}

interface ThreadProps {
  agent: AgentSummary;
  jobs: JobSummary[];
  session: string;
  draftKey: number;
  title?: string;
  lang: Language;
  t: Translate;
  onSession: (sessionId: string) => void;
  reloadSessions: () => void;
  refreshState: () => Promise<void>;
}

function makeChatThread(React: ReactModule, ctx: ClientContext, primitives: ChatPrimitives) {
  const h = React.createElement;
  const icons = makeIcons(React);
  const { CommandText, MarkdownText, UserMessageBubble } = primitives;
  const submissions = new Map<string, { message: string; sessionId: string; id: string }>();
  const lastIdleBaselines = new Map<string, { length: number; lastId?: string; lastUserId?: string }>();

  return function ChatThread({
    agent,
    jobs,
    session,
    draftKey,
    title,
    lang,
    t,
    onSession,
    reloadSessions,
    refreshState,
  }: ThreadProps) {
    const [sessionId, setSessionId] = React.useState(session);
    const submissionKey = (id: string) => `${agent.revision}\0${id ? `session:${id}` : `draft:${draftKey}`}`;
    const submission = React.useRef(submissions.get(submissionKey(session)));
    const [input, setInput] = React.useState(() => submission.current?.message ?? '');
    const [sending, setSending] = React.useState(false);
    const [acting, setActing] = React.useState(false);
    const [error, setError] = React.useState('');
    const [jobError, setJobError] = React.useState('');
    const [unavailableJobId, setUnavailableJobId] = React.useState<string | undefined>(undefined);
    const [historyError, setHistoryError] = React.useState('');
    const [history, setHistory] = React.useState<TranscriptMessage[] | null>(null);
    const [historyMeta, setHistoryMeta] = React.useState<{ fetchedWhileRunning: boolean; settledJobId?: string }>({
      fetchedWhileRunning: false,
    });
    const [historyAttempts, setHistoryAttempts] = React.useState(0);
    const [turns, setTurns] = React.useState<JobSummary[]>([]);
    const belongsToSession = (job: JobSummary) =>
      Boolean(sessionId && job.sessionId === sessionId && job.agentId === agent.id);
    const [initialJob] = React.useState(() => jobs.find((job) => belongsToSession(job) && isRunning(job)));
    const [observedJob, setObservedJob] = React.useState(initialJob);
    const [historyJobId, setHistoryJobId] = React.useState(initialJob?.id);
    const [retryMatchedJobId, setRetryMatchedJobId] = React.useState<string | undefined>(undefined);
    const sessionBaselineKey = session ? `${agent.revision}\0${session}` : '';
    const historyBaselines = React.useRef<Map<string, { length: number; lastId?: string; lastUserId?: string }>>(
      (() => {
        const seeded = new Map<string, { length: number; lastId?: string; lastUserId?: string }>();
        const prior = sessionBaselineKey ? lastIdleBaselines.get(sessionBaselineKey) : undefined;
        if (initialJob && prior) seeded.set(initialJob.id, prior);
        return seeded;
      })(),
    );
    const latestProgress = React.useRef<JobSummary | undefined>(initialJob);
    const [copyStatus, setCopyStatus] = React.useState('');
    const [copiedOk, setCopiedOk] = React.useState(false);
    const copyTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const alive = React.useRef(false);
    const sendLock = React.useRef(false);
    const actionLock = React.useRef(false);
    const log = React.useRef<HTMLDivElement | null>(null);
    const composerRef = React.useRef<HTMLTextAreaElement | null>(null);
    const followTail = React.useRef(true);
    const canReadHistory = Boolean(agent.supportsSessionMessages && session);
    const isAvailableAndRunning = (job?: JobSummary) => job?.id !== unavailableJobId && isRunning(job);
    const observedJobRunning = Boolean(observedJob && isAvailableAndRunning(observedJob));

    React.useEffect(() => {
      alive.current = true;
      return () => {
        alive.current = false;
        if (copyTimer.current) clearTimeout(copyTimer.current);
      };
    }, []);

    React.useEffect(() => {
      const el = composerRef.current;
      if (!el) return;
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    }, [input]);

    React.useEffect(() => {
      if (!canReadHistory) return;
      const controller = new AbortController();
      const runningJobId = observedJobRunning ? observedJob?.id : undefined;
      const settledJobId =
        !observedJobRunning && observedJob && !isAvailableAndRunning(observedJob) ? observedJob.id : undefined;
      if (runningJobId && sessionBaselineKey && !historyBaselines.current.has(runningJobId)) {
        const prior = lastIdleBaselines.get(sessionBaselineKey);
        if (prior) historyBaselines.current.set(runningJobId, prior);
      }
      setHistoryError('');
      void apiPost<{ messages: TranscriptMessage[] }>(
        ctx,
        '/api/dsh-knot/session-messages',
        { agentId: agent.id, revision: agent.revision, sessionId: session },
        15_000,
        controller.signal,
      )
        .then(({ messages }) => {
          if (controller.signal.aborted) return;
          const snapshot = {
            length: messages.length,
            lastId: messages.at(-1)?.id,
            lastUserId: messages.findLast((item) => item.role === 'user')?.id,
          };
          if (runningJobId) {
            if (!historyBaselines.current.has(runningJobId)) {
              historyBaselines.current.set(runningJobId, snapshot);
            }
          } else if (sessionBaselineKey) {
            lastIdleBaselines.delete(sessionBaselineKey);
            lastIdleBaselines.set(sessionBaselineKey, snapshot);
            if (lastIdleBaselines.size > 200) {
              const oldest = lastIdleBaselines.keys().next().value;
              if (oldest !== undefined) lastIdleBaselines.delete(oldest);
            }
          }
          if (runningJobId ?? settledJobId) setHistoryJobId(runningJobId ?? settledJobId);
          setHistoryMeta({ fetchedWhileRunning: Boolean(runningJobId), settledJobId });
          setHistory(messages);
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) setHistoryError(errorMessage(error));
        });
      return () => controller.abort();
    }, [agent.id, agent.revision, canReadHistory, historyAttempts, observedJobRunning, observedJob?.id, session]);

    const ownRunning = turns.find(isAvailableAndRunning);
    const listedRunning = jobs.find(
      (job) =>
        belongsToSession(job) &&
        isAvailableAndRunning(job) &&
        !turns.some(({ id }) => id === job.id) &&
        (job.id !== observedJob?.id || isAvailableAndRunning(observedJob)),
    );
    const activeJob = ownRunning ?? (isAvailableAndRunning(observedJob) ? observedJob : listedRunning);
    const activeId = activeJob?.id;
    const progressId = activeJob?.remoteStop === 'unconfirmed' ? undefined : activeId;
    const ownActiveId = ownRunning?.id;

    const applyProgress = React.useCallback(
      (job: JobSummary, own: boolean) => {
        if (!alive.current) return;
        const previous = latestProgress.current;
        if (previous?.id === job.id && (previous.updatedAt > job.updatedAt || (!isRunning(previous) && isRunning(job))))
          return;
        latestProgress.current = job;
        if (own) {
          setTurns((current) => current.map((item) => (item.id === job.id ? { ...job, prompt: item.prompt } : item)));
        } else setObservedJob(job);
        if (job.sessionId) {
          setSessionId(job.sessionId);
          onSession(job.sessionId);
        }
        if (!isRunning(job)) {
          reloadSessions();
          void refreshState();
        }
      },
      [onSession, reloadSessions, refreshState],
    );

    React.useEffect(() => {
      if (!progressId) return;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const poll = async () => {
        let delay = 400;
        try {
          const job = await apiPost<JobSummary>(
            ctx,
            '/api/dsh-knot/job',
            { agentId: agent.id, revision: agent.revision, jobId: progressId },
            8_000,
            controller.signal,
          );
          if (controller.signal.aborted) return;
          setJobError('');
          applyProgress(job, progressId === ownActiveId);
          if (!isRunning(job) || job.remoteStop === 'unconfirmed') return;
        } catch (error) {
          if (controller.signal.aborted) return;
          setJobError(errorMessage(error));
          if (error instanceof ApiError && (error.status === 404 || error.status === 409)) {
            setUnavailableJobId(progressId);
            void refreshState();
            return;
          }
          delay = 2_000;
        }
        timer = setTimeout(() => void poll(), delay);
      };
      void poll();
      return () => {
        controller.abort();
        clearTimeout(timer);
      };
    }, [progressId, ownActiveId, agent.id, agent.revision, applyProgress, refreshState]);

    React.useEffect(() => {
      if (followTail.current && log.current) log.current.scrollTop = log.current.scrollHeight;
    }, [history, turns, observedJob]);

    const historyPending = canReadHistory && !history && !historyError;
    const lastMessage = history?.at(-1);
    const lastUserText = history?.findLast(({ role }) => role === 'user')?.text;
    const send = async () => {
      const message = input.trim();
      if (!message || activeId || historyPending || sendLock.current || actionLock.current) return;
      const key = submissionKey(sessionId);
      let request = submissions.get(key) ?? submission.current;
      const retry = Boolean(request?.message === message && request.sessionId === sessionId);
      if (!request || !retry) {
        const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
          byte.toString(16).padStart(2, '0'),
        ).join('');
        request = { message, sessionId, id };
      }
      submissions.set(key, request);
      if (submissions.size > 100) {
        const oldest = submissions.keys().next().value;
        if (oldest !== undefined) submissions.delete(oldest);
      }
      submission.current = request;
      sendLock.current = true;
      setSending(true);
      setError('');
      setJobError('');
      followTail.current = true;
      try {
        const job = await apiPost<JobSummary>(
          ctx,
          '/api/dsh-knot/ask',
          {
            agentId: agent.id,
            revision: agent.revision,
            message: request.message,
            clientMessageId: request.id,
            ...(request.sessionId ? { sessionId: request.sessionId } : {}),
          },
          15_000,
        );
        if (submissions.get(key) === request) submissions.delete(key);
        void refreshState();
        if (!alive.current) return;
        submission.current = undefined;
        setInput('');
        if (
          job.id === initialJob?.id ||
          (retry &&
            job.status === 'completed' &&
            lastMessage?.role === 'assistant' &&
            lastMessage.text === job.text &&
            lastUserText === request.message)
        ) {
          setHistoryJobId(job.id);
          if (job.id !== initialJob?.id) setRetryMatchedJobId(job.id);
          applyProgress(job, false);
          return;
        }
        setTurns((current) => [
          ...current.filter(({ id }) => id !== job.id).slice(-19),
          { ...job, prompt: request.message },
        ]);
        applyProgress(job, true);
      } catch (error) {
        if (alive.current) setError(errorMessage(error));
      } finally {
        sendLock.current = false;
        if (alive.current) setSending(false);
      }
    };

    const actOnJob = async (path: 'cancel' | 'respond', job: JobSummary, fields: Record<string, unknown> = {}) => {
      if (actionLock.current) return;
      actionLock.current = true;
      setActing(true);
      setError('');
      try {
        const updated = await apiPost<JobSummary>(ctx, `/api/dsh-knot/${path}`, { jobId: job.id, ...fields }, 15_000);
        applyProgress(updated, job.id === ownActiveId);
      } catch (error) {
        if (alive.current) setError(errorMessage(error));
      } finally {
        actionLock.current = false;
        if (alive.current) setActing(false);
      }
    };

    const copyPrompt = async () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
      try {
        await navigator.clipboard.writeText(
          `Use agent_continue on agent "${agent.id}" session "${sessionId}" to continue our previous discussion.`,
        );
        if (!alive.current) return;
        setCopiedOk(true);
        setCopyStatus(t('copiedContinue'));
      } catch {
        if (!alive.current) return;
        setCopiedOk(false);
        setCopyStatus(t('chatCopyError'));
      }
      copyTimer.current = setTimeout(() => {
        copyTimer.current = null;
        if (!alive.current) return;
        setCopiedOk(false);
        setCopyStatus('');
      }, 2600);
    };

    const toolStateClass = (toolStatus: ToolStatus): string =>
      toolStatus === 'completed'
        ? 'dk-chat-activity-state is-ok'
        : toolStatus === 'failed'
          ? 'dk-chat-activity-state is-err'
          : toolStatus === 'running'
            ? 'dk-chat-activity-state is-run'
            : 'dk-chat-activity-state';

    const renderAssistant = (key: string | undefined, children: unknown[]) =>
      h(
        'div',
        { ...(key ? { key } : {}), className: 'dk-chat-assistant' },
        h('span', { className: 'dk-chat-mark', 'aria-hidden': true }, icons.knot(13)),
        h('div', { className: 'dk-chat-assistant-body' }, ...children),
      );

    const renderThoughtBlock = (key: string, text: string, streaming = false) =>
      h(
        'details',
        { key, className: 'dk-chat-activity' },
        h('summary', null, icons.chevronRight(13, 'dk-chat-activity-chevron'), h('span', null, t('chatThought'))),
        h(MarkdownText, {
          className: 'dk-chat-thought',
          text,
          streaming,
          labels: MARKDOWN_LABELS[lang],
          variant: 'compact',
          omitHtml: true,
        }),
      );

    const renderToolGroup = (key: string, toolItems: ToolActivitySummary[]) => {
      const running = toolItems.filter((tool) => tool.status === 'running');
      const single = toolItems.length === 1 ? toolItems[0] : undefined;
      return h(
        'details',
        { key, className: 'dk-chat-activity' },
        h(
          'summary',
          null,
          icons.chevronRight(13, 'dk-chat-activity-chevron'),
          h('span', null, `${t('chatToolActivity')} · ${toolItems.length}`),
          running.length
            ? h(
                'span',
                { className: 'dk-chat-activity-state is-run', role: 'status' },
                `· ${t('chatToolRunning')} ${running.map(({ name, title }) => title ?? name).join(', ')}`,
              )
            : single
              ? h('span', { className: 'dk-chat-activity-name dk-mono' }, `· ${single.title ?? single.name}`)
              : null,
        ),
        h(
          'ul',
          null,
          toolItems.map((tool) =>
            h(
              'li',
              { key: tool.id },
              h('span', { className: 'dk-chat-activity-name dk-mono' }, tool.title ?? tool.name),
              h('span', { className: toolStateClass(tool.status) }, t(TOOL_STATUS_LABEL[tool.status])),
              tool.inputPreview
                ? h(CommandText, {
                    className: 'dk-chat-activity-input',
                    text: tool.inputPreview,
                    label: t('chatToolInput'),
                  })
                : null,
            ),
          ),
        ),
      );
    };

    const renderTextBlock = (key: string, text: string, streaming = false) =>
      h(
        'div',
        { key, className: 'dk-chat-markdown' },
        h(MarkdownText, { text, streaming, labels: MARKDOWN_LABELS[lang], omitHtml: true }),
      );

    interface MatchedLiveTurn {
      startIndex: number;
      persistedTurn: TranscriptMessage[];
      suppressPromptOnly?: boolean;
    }

    const matchObservedTurnInHistory = (
      job: JobSummary | undefined,
      matchedHistory: boolean,
    ): MatchedLiveTurn | undefined => {
      if (!matchedHistory || !history?.length || !job) return undefined;
      let lastUserIndex = -1;
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i]?.role === 'user') {
          lastUserIndex = i;
          break;
        }
      }
      const lastUser = lastUserIndex >= 0 ? history[lastUserIndex] : undefined;
      const promptMatches = Boolean(job.prompt) && lastUser?.text === job.prompt;
      const activeLive = isAvailableAndRunning(job);
      // While the job is still running, any assistant rows in history belong to an earlier turn;
      // only suppress the user bubble when the gateway already persisted this prompt as the trailing row.
      if (activeLive) {
        if (promptMatches && lastMessage?.role === 'user') {
          return { startIndex: history.length, persistedTurn: [], suppressPromptOnly: true };
        }
        return undefined;
      }
      const turnStart = Math.max(lastUserIndex, 0);
      const lastTurnAssistant = (lastUserIndex >= 0 ? history.slice(lastUserIndex + 1) : history).filter(
        (item) => item.role === 'assistant',
      );
      if (job.prompt && !promptMatches) return undefined;
      const joinedAssistantText = lastTurnAssistant.map((item) => item.text).join('');
      const replyMatches =
        lastMessage?.role === 'assistant' &&
        Boolean(job.text) &&
        (lastMessage.text === job.text ||
          joinedAssistantText === job.text ||
          (Boolean(lastMessage.text) && job.text.endsWith(lastMessage.text)));
      const contentMatches = replyMatches || (!job.text && promptMatches && lastTurnAssistant.length > 0);
      if (!contentMatches) {
        if (promptMatches && lastMessage?.role === 'user') {
          return { startIndex: history.length, persistedTurn: [], suppressPromptOnly: true };
        }
        return undefined;
      }

      // Prove that history actually includes THIS settled run rather than an identical previous turn:
      // 1) Explicit idempotent retry already matched on send()
      const retryProven = retryMatchedJobId === job.id;
      // 2) History fetched after completion strictly advanced past the pre-completion baseline
      // (provider tool-call IDs can repeat across turns, so they must never override an unchanged tail).
      const baseline = historyBaselines.current.get(job.id);
      const postCompleteFetch = !historyMeta.fetchedWhileRunning && historyMeta.settledJobId === job.id;
      const baselineEndedOnAssistant = Boolean(baseline?.lastId && baseline.lastId !== baseline.lastUserId);
      const historyAdvanced = Boolean(
        baseline &&
          postCompleteFetch &&
          (history.length > baseline.length || history.at(-1)?.id !== baseline.lastId) &&
          (!baselineEndedOnAssistant || lastUser?.id !== baseline.lastUserId),
      );
      // 3) A fast job that settled before any baseline could be captured, matched by a post-completion fetch
      const postCompleteUnbaselined = !baseline && postCompleteFetch;
      if (!retryProven && !historyAdvanced && !postCompleteUnbaselined) return undefined;

      return { startIndex: turnStart, persistedTurn: history.slice(turnStart) };
    };

    const liveJob = (isAvailableAndRunning(observedJob) ? observedJob : listedRunning) ?? observedJob;
    const loadedObservedJob = Boolean(history && liveJob?.id === historyJobId);
    const liveIsOwnTurn = Boolean(liveJob && turns.some(({ id }) => id === liveJob.id));
    const matchedLiveTurn = liveIsOwnTurn ? undefined : matchObservedTurnInHistory(liveJob, loadedObservedJob);
    const fallbackJobs =
      !agent.supportsSessionMessages && sessionId
        ? jobs.filter(
            (job) => belongsToSession(job) && !turns.some(({ id }) => id === job.id) && job.id !== liveJob?.id,
          )
        : [];

    type TurnSegment =
      | { kind: 'thought'; text: string }
      | { kind: 'commentary'; text: string }
      | { kind: 'tool'; tool: ToolActivitySummary }
      | { kind: 'text'; text: string };

    const mergeToolDetails = (live: ToolActivitySummary, persisted?: ToolActivitySummary): ToolActivitySummary => {
      const name = live.name && live.name !== 'tool' ? live.name : persisted?.name || live.name;
      const title = live.title || persisted?.title;
      const inputPreview = live.inputPreview || persisted?.inputPreview;
      return {
        ...persisted,
        ...live,
        name,
        status: live.status,
        ...(title ? { title } : {}),
        ...(inputPreview ? { inputPreview } : {}),
      };
    };

    const mergeTurnSegments = (live: TurnSegment[], persisted: TurnSegment[]): TurnSegment[] => {
      if (!persisted.length) return live;
      if (!live.length) return persisted;
      const thoughtsMatch = (a: string, b: string): boolean => {
        const ta = a.trim();
        const tb = b.trim();
        return Boolean(ta && tb && (ta === tb || ta.includes(tb) || tb.includes(ta)));
      };
      const matchWeight = (p: TurnSegment, l: TurnSegment): number => {
        if (p.kind === 'tool' && l.kind === 'tool') return p.tool.id === l.tool.id ? 3 : 0;
        if (p.kind === 'text' && (l.kind === 'text' || l.kind === 'commentary')) {
          return p.text.trim() && p.text.trim() === l.text.trim() ? 2 : 0;
        }
        if (p.kind === 'thought' && l.kind === 'thought') return thoughtsMatch(p.text, l.text) ? 1 : 0;
        return 0;
      };
      const P = persisted.length;
      const L = live.length;
      const dp: number[][] = Array.from({ length: P + 1 }, () => new Array<number>(L + 1).fill(0));
      for (let i = P - 1; i >= 0; i--) {
        for (let j = L - 1; j >= 0; j--) {
          let best = Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
          const weight = matchWeight(persisted[i]!, live[j]!);
          if (weight > 0) best = Math.max(best, weight + dp[i + 1]![j + 1]!);
          dp[i]![j] = best;
        }
      }
      const anchors: Array<[number, number]> = [];
      let pi = 0;
      let li = 0;
      while (pi < P && li < L) {
        const weight = matchWeight(persisted[pi]!, live[li]!);
        if (weight > 0 && dp[pi]![li] === weight + dp[pi + 1]![li + 1]!) {
          anchors.push([pi, li]);
          pi++;
          li++;
        } else if (dp[pi + 1]![li]! >= dp[pi]![li + 1]!) {
          pi++;
        } else {
          li++;
        }
      }

      const persistedToolById = new Map<string, ToolActivitySummary>();
      for (const seg of persisted) {
        if (seg.kind === 'tool' && !persistedToolById.has(seg.tool.id)) persistedToolById.set(seg.tool.id, seg.tool);
      }
      const liveToolIds = new Set<string>();
      for (const seg of live) {
        if (seg.kind === 'tool') liveToolIds.add(seg.tool.id);
      }
      const emittedToolIds = new Set<string>();
      const merged: TurnSegment[] = [];

      const emitGap = (pStart: number, pEnd: number, lStart: number, lEnd: number) => {
        const unmatchedP = persisted.slice(pStart, pEnd);
        const unmatchedL = live.slice(lStart, lEnd);
        const persistedTexts = unmatchedP
          .filter((seg): seg is { kind: 'text'; text: string } => seg.kind === 'text')
          .map((seg) => seg.text.trim())
          .filter(Boolean);
        const joinedPersisted = persistedTexts.join('');
        const joinedPersistedLines = persistedTexts.join('\n');

        for (const seg of unmatchedP) {
          if (seg.kind === 'tool') {
            // Tools with a live timeline position are emitted at their live slot (merged with persisted details).
            if (liveToolIds.has(seg.tool.id) || emittedToolIds.has(seg.tool.id)) continue;
            emittedToolIds.add(seg.tool.id);
          }
          merged.push(seg);
        }
        for (const seg of unmatchedL) {
          if (seg.kind === 'tool') {
            if (emittedToolIds.has(seg.tool.id)) continue;
            emittedToolIds.add(seg.tool.id);
            merged.push({ kind: 'tool', tool: mergeToolDetails(seg.tool, persistedToolById.get(seg.tool.id)) });
            continue;
          }
          if (
            (seg.kind === 'text' || seg.kind === 'commentary') &&
            persistedTexts.length > 0 &&
            (seg.text.trim() === joinedPersisted || seg.text.trim() === joinedPersistedLines)
          ) {
            continue;
          }
          merged.push(seg);
        }
      };

      let prevP = 0;
      let prevL = 0;
      for (const [anchorP, anchorL] of anchors) {
        emitGap(prevP, anchorP, prevL, anchorL);
        const pSeg = persisted[anchorP]!;
        const lSeg = live[anchorL]!;
        if (pSeg.kind === 'tool' && lSeg.kind === 'tool') {
          if (!emittedToolIds.has(lSeg.tool.id)) {
            emittedToolIds.add(lSeg.tool.id);
            merged.push({ kind: 'tool', tool: mergeToolDetails(lSeg.tool, pSeg.tool) });
          }
        } else if (pSeg.kind === 'thought' && lSeg.kind === 'thought') {
          merged.push({
            kind: 'thought',
            text: pSeg.text.trim().length > lSeg.text.trim().length ? pSeg.text : lSeg.text,
          });
        } else {
          merged.push(lSeg);
        }
        prevP = anchorP + 1;
        prevL = anchorL + 1;
      }
      emitGap(prevP, P, prevL, L);
      return merged;
    };

    const renderJob = (job: JobSummary, matchedTurn?: MatchedLiveTurn) => {
      const active = isAvailableAndRunning(job);
      const approval = active ? job.pendingApproval : undefined;
      const status =
        job.remoteStop === 'pending'
          ? 'chatStopping'
          : job.remoteStop === 'unconfirmed'
            ? 'chatStopUnconfirmed'
            : approval
              ? 'wantsApproval'
              : 'chatPreparing';
      const terminalNotice = job.status === 'failed' || (job.status === 'cancelled' && !job.remoteStop);
      const persistedTurn = matchedTurn?.persistedTurn ?? [];
      const persistedUser = persistedTurn.find((item) => item.role === 'user');
      const persistedAssistant = persistedTurn.filter((item) => item.role === 'assistant');
      const showPrompt = !matchedTurn?.suppressPromptOnly;
      const promptText = persistedUser?.text ?? job.prompt;

      const liveToolById = new Map<string, ToolActivitySummary>((job.tools ?? []).map((tool) => [tool.id, tool]));
      const effectiveTimeline: TimelineEntry[] = job.timeline?.length
        ? job.timeline
        : [
            ...(job.thought ? [{ kind: 'thought' as const, text: job.thought }] : []),
            ...(job.tools ?? []).map((tool) => ({ kind: 'tool' as const, toolId: tool.id })),
            ...(job.text ? [{ kind: 'text' as const, text: job.text }] : []),
          ];
      const liveSegments: TurnSegment[] = [];
      for (const entry of effectiveTimeline) {
        if (entry.kind === 'tool') {
          const tool = liveToolById.get(entry.toolId);
          if (tool) liveSegments.push({ kind: 'tool', tool });
        } else if (entry.text) {
          liveSegments.push(entry);
        }
      }
      const persistedSegments: TurnSegment[] = [];
      for (const msg of persistedAssistant) {
        if (msg.thought) persistedSegments.push({ kind: 'thought', text: msg.thought });
        if (msg.text.trim()) persistedSegments.push({ kind: 'text', text: msg.text });
        for (const tool of msg.tools ?? []) persistedSegments.push({ kind: 'tool', tool });
      }
      const mergedSegments = mergeTurnSegments(liveSegments, persistedSegments);

      const contentParts: unknown[] = [];
      let pendingTools: ToolActivitySummary[] = [];
      const flushTools = (suffix: string) => {
        if (pendingTools.length > 0) {
          contentParts.push(renderToolGroup(`tools-${suffix}`, pendingTools));
          pendingTools = [];
        }
      };
      mergedSegments.forEach((segment, index) => {
        if (segment.kind === 'tool') {
          pendingTools.push(segment.tool);
          return;
        }
        flushTools(`seg-${index}`);
        if (segment.kind === 'thought') {
          contentParts.push(renderThoughtBlock(`thought-${index}`, segment.text, active));
        } else {
          contentParts.push(renderTextBlock(`${segment.kind}-${index}`, segment.text, active));
        }
      });
      flushTools('tail');

      const hasPrompt = Boolean(showPrompt && promptText);
      const hasAssistantContent = Boolean(contentParts.length > 0 || active || approval || terminalNotice);
      if (!hasPrompt && !hasAssistantContent) return null;
      const assistantParts = [
        ...contentParts,
        active
          ? h(
              'div',
              { key: 'status', className: 'dk-chat-status' },
              h('span', { className: 'dk-dot dk-dot-live', 'aria-hidden': true }),
              h('span', { role: 'status' }, t(status)),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dk-btn dk-btn-sm',
                  disabled: acting || job.remoteStop === 'pending',
                  onClick: () => void actOnJob('cancel', job),
                },
                icons.stop(11),
                t('stopTask'),
              ),
            )
          : null,
        approval
          ? h(
              'div',
              { key: 'approval', className: 'dk-warnbox' },
              h('div', { style: { fontWeight: 600, fontSize: '12.5px' } }, t('wantsApproval')),
              h('pre', { className: 'dk-pre dk-mono' }, approval.text ?? approval.requestId),
              h(
                'div',
                { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } },
                agent.supportsRespond !== false && approval.choices.length
                  ? approval.choices.map((choice) =>
                      h(
                        'button',
                        {
                          key: choice,
                          type: 'button',
                          className: /deny|reject|no/i.test(choice)
                            ? 'dk-btn dk-btn-sm dk-btn-danger-armed'
                            : 'dk-btn dk-btn-sm dk-btn-primary',
                          disabled: acting,
                          onClick: () => void actOnJob('respond', job, { requestId: approval.requestId, choice }),
                        },
                        choice,
                      ),
                    )
                  : h('div', { className: 'dk-muted' }, t('approveRemotely')),
              ),
            )
          : null,
        terminalNotice
          ? h(
              'div',
              {
                key: 'terminal',
                className: job.status === 'failed' ? 'dk-errbox' : 'dk-muted',
                role: 'status',
              },
              t(job.status === 'failed' ? 'chatFailed' : 'chatCancelled'),
              job.error ? ` · ${job.error}` : '',
            )
          : null,
      ];
      return h(
        'div',
        { key: job.id, className: 'dk-chat-turn' },
        hasPrompt ? h(UserMessageBubble, { className: 'dk-chat-user' }, promptText) : null,
        hasAssistantContent ? renderAssistant(undefined, assistantParts) : null,
      );
    };

    const renderHistoryItems = () => {
      if (!history?.length) return null;
      const visibleHistory =
        matchedLiveTurn && !matchedLiveTurn.suppressPromptOnly ? history.slice(0, matchedLiveTurn.startIndex) : history;
      if (!visibleHistory.length) return null;
      const items: unknown[] = [];
      let assistantBatch: TranscriptMessage[] = [];
      const flushAssistantBatch = () => {
        if (!assistantBatch.length) return;
        const first = assistantBatch[0]!;
        const parts: unknown[] = [];
        for (const msg of assistantBatch) {
          if (msg.thought) parts.push(renderThoughtBlock(`${msg.id}-thought`, msg.thought));
          if (msg.text.trim()) parts.push(renderTextBlock(`${msg.id}-text`, msg.text));
          if (msg.tools?.length) parts.push(renderToolGroup(`${msg.id}-tools`, msg.tools));
        }
        if (parts.length) items.push(renderAssistant(first.id, parts));
        assistantBatch = [];
      };
      for (const message of visibleHistory) {
        if (message.role === 'user') {
          flushAssistantBatch();
          items.push(h(UserMessageBubble, { key: message.id, className: 'dk-chat-user' }, message.text));
        } else {
          assistantBatch.push(message);
        }
      }
      flushAssistantBatch();
      return items;
    };

    const endpoint = agent.acpTransport === 'stdio' ? 'Local stdio' : formatDirectEndpoint(agent);

    return h(
      'section',
      { className: 'dk-chat-thread', 'aria-label': title || t('chatHeading') },
      h(
        'div',
        { className: 'dk-chat-thread-header' },
        h(
          'div',
          { className: 'dk-chat-thread-left' },
          h('h2', { title: title || sessionId }, title || sessionId || t('chatNewSession')),
          h('span', { className: 'dk-chat-thread-agent' }, `${agent.id} · ${agent.kind}`),
        ),
        sessionId
          ? h(
              'button',
              {
                type: 'button',
                className: 'dk-btn dk-btn-sm dk-btn-ghost',
                onClick: () => void copyPrompt(),
              },
              copiedOk ? icons.check(13) : icons.copy(13),
              copiedOk ? t('copiedShort') : t('continuePrompt'),
            )
          : null,
      ),
      h(
        'div',
        {
          className: 'dk-chat-log',
          ref: log,
          onScroll: ({ currentTarget }: { currentTarget: HTMLDivElement }) => {
            followTail.current = currentTarget.scrollHeight - currentTarget.scrollTop - currentTarget.clientHeight < 64;
          },
        },
        h(
          'div',
          { className: 'dk-chat-messages' },
          historyPending ? h('div', { className: 'dk-muted', role: 'status' }, t('chatHistoryLoading')) : null,
          historyError
            ? h(
                'div',
                { className: 'dk-errbox', role: 'alert' },
                h('span', null, `${t('chatHistoryError')}: ${historyError}`),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dk-btn dk-btn-sm',
                    style: { alignSelf: 'flex-start' },
                    disabled: Boolean(activeId || turns.length || sending),
                    onClick: () => setHistoryAttempts((attempts) => attempts + 1),
                  },
                  t('retry'),
                ),
              )
            : null,
          session && !agent.supportsSessionMessages
            ? h('div', { className: 'dk-infobox' }, t('chatHistoryUnavailable'))
            : null,
          !sessionId && !turns.length
            ? h(
                'div',
                { className: 'dk-chat-welcome' },
                h('span', { className: 'dk-chat-welcome-mark', 'aria-hidden': true }, icons.knot(18)),
                h('div', { className: 'dk-chat-welcome-title' }, agent.id),
                h('div', { className: 'dk-muted dk-mono' }, endpoint),
                h('div', { className: 'dk-muted', style: { marginTop: '4px' } }, t('chatEmpty')),
              )
            : null,
          renderHistoryItems(),
          fallbackJobs
            .sort((a, b) => a.createdAt - b.createdAt)
            .slice(-20)
            .map((job) => renderJob(job)),
          liveJob && !liveIsOwnTurn ? renderJob(liveJob, matchedLiveTurn) : null,
          turns.map((job) => renderJob(job)),
        ),
      ),
      h(
        'form',
        {
          className: 'dk-chat-form',
          onSubmit: (event: { preventDefault(): void }) => {
            event.preventDefault();
            void send();
          },
        },
        h(
          'div',
          { className: 'dk-chat-form-inner' },
          copyStatus
            ? h('div', { className: 'dk-muted', role: 'status', style: { paddingLeft: '6px' } }, copyStatus)
            : null,
          error || jobError
            ? h('div', { className: 'dk-errbox', role: 'alert' }, error || `${t('chatJobError')}: ${jobError}`)
            : null,
          h(
            'div',
            { className: 'dk-chat-composer-box' },
            h('textarea', {
              ref: composerRef,
              className: 'dk-chat-textarea',
              rows: 1,
              'aria-label': t('chatPlaceholder'),
              placeholder: t('chatPlaceholder'),
              value: input,
              readOnly: sending,
              onInput: (event: { target: HTMLTextAreaElement }) => setInput(event.target.value),
              onKeyDown: (event: {
                key: string;
                shiftKey: boolean;
                nativeEvent: KeyboardEvent;
                preventDefault(): void;
              }) => {
                if (
                  event.key === 'Enter' &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing &&
                  event.nativeEvent.keyCode !== 229
                ) {
                  event.preventDefault();
                  void send();
                }
              },
            }),
            h(
              'div',
              { className: 'dk-chat-composer-bar' },
              h('span', { className: 'dk-chat-hint' }, t('chatComposerHint')),
              h(
                'button',
                {
                  type: 'submit',
                  className: 'dk-send-circle',
                  title: t(sending ? 'chatSending' : 'chatSend'),
                  'aria-label': t(sending ? 'chatSending' : 'chatSend'),
                  disabled: Boolean(sending || acting || activeId || historyPending || !input.trim()),
                },
                icons.send(15),
              ),
            ),
          ),
        ),
      ),
    );
  };
}

function makeDashboard(React: ReactModule, ctx: ClientContext, primitives: ChatPrimitives) {
  const h = React.createElement;
  const icons = makeIcons(React);
  const Chat = makeRemoteChat(React, ctx, primitives);

  return function KnotDashboard() {
    const locale = getClientService<ClientLocale>(ctx, 'locale');
    const initialLang = String(locale?.current ?? 'zh').startsWith('en') ? 'en' : 'zh-CN';
    const [lang, setLang] = React.useState<'zh-CN' | 'en'>(initialLang);
    const [state, setState] = React.useState<KnotState | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [expandedDoctor, setExpandedDoctor] = React.useState<Record<string, boolean>>({});
    const [checkingDoctor, setCheckingDoctor] = React.useState(false);
    const [chatAgentId, setChatAgentId] = React.useState('');
    const [toast, setToast] = React.useState<string | null>(null);
    const [form, setForm] = React.useState<AgentFormState | null>(null);
    const [saving, setSaving] = React.useState(false);
    const [confirmDeleteId, setConfirmDeleteId] = React.useState<string | null>(null);
    const toastTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const stateRequest = React.useRef(0);
    const hasRunningRef = React.useRef(false);

    const t = (key: string): string => DICTS[lang]?.[key] ?? DICTS.en?.[key] ?? key;

    const showToast = React.useCallback((message: string) => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
      setToast(message);
      toastTimer.current = setTimeout(() => {
        toastTimer.current = null;
        setToast(null);
      }, 2400);
    }, []);

    React.useEffect(() => {
      return () => {
        if (toastTimer.current) clearTimeout(toastTimer.current);
      };
    }, []);

    const refreshState = React.useCallback(async () => {
      const current = ++stateRequest.current;
      try {
        const next = await apiPost<KnotState>(ctx, '/api/dsh-knot/state', {}, 15_000);
        if (current !== stateRequest.current) return;
        setState(next);
        hasRunningRef.current = next.jobs.some((j) => j.status === 'running' || j.status === 'queued');
        setError(null);
      } catch (err) {
        if (current === stateRequest.current) setError(err instanceof Error ? err.message : String(err));
      }
    }, []);

    React.useEffect(() => {
      void refreshState();
      let timer: ReturnType<typeof setTimeout> | null = null;
      let cancelled = false;
      const schedule = () => {
        if (cancelled) return;
        timer = setTimeout(
          async () => {
            await refreshState();
            schedule();
          },
          hasRunningRef.current ? 1500 : 5000,
        );
      };
      schedule();
      return () => {
        cancelled = true;
        if (timer) clearTimeout(timer);
      };
    }, [refreshState]);

    const runDoctorAll = async (onlyAgent?: string) => {
      setCheckingDoctor(true);
      try {
        const result = await apiPost<{ agents: Array<{ id: string; steps: DoctorStep[] }> }>(
          ctx,
          '/api/dsh-knot/doctor',
          onlyAgent ? { agent: onlyAgent } : {},
          30_000,
        );
        const nextOpen: Record<string, boolean> = {};
        for (const item of result.agents) {
          nextOpen[item.id] = true;
        }
        setExpandedDoctor((prev) => ({ ...prev, ...nextOpen }));
        await refreshState();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setCheckingDoctor(false);
      }
    };

    const respondApproval = async (jobId: string, requestId: string, choice: string) => {
      try {
        await apiPost(ctx, '/api/dsh-knot/respond', { jobId, requestId, choice });
        await refreshState();
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err));
      }
    };

    const cancelJob = async (jobId: string) => {
      try {
        await apiPost(ctx, '/api/dsh-knot/cancel', { jobId });
        await refreshState();
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err));
      }
    };

    const toggleShare = async (sessionId: string, allow: boolean) => {
      try {
        await apiPost(ctx, '/api/dsh-knot/mcp-share', { sessionId, allow });
        await refreshState();
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err));
      }
    };

    const openAddForm = () => {
      setForm({
        editing: false,
        hasToken: false,
        clearToken: false,
        id: '',
        kind: 'hermes',
        transport: 'direct',
        endpoint: '',
        host: '',
        port: '',
        token: '',
        model: '',
        acpTransport: 'websocket',
        acpCommand: '',
        acpArgsText: '',
      });
    };

    const openEditForm = (agent: AgentSummary) => {
      const transport = agent.transport === 'local' ? 'local' : 'direct';
      setForm({
        editing: true,
        hasToken: Boolean(agent.hasToken),
        clearToken: false,
        id: agent.id,
        kind: agent.kind,
        transport,
        endpoint: transport === 'direct' && agent.host ? formatDirectEndpoint(agent) : '',
        host: agent.host ?? '127.0.0.1',
        port: agent.port ? String(agent.port) : '',
        token: '',
        model: agent.model ?? '',
        acpTransport: transport === 'local' ? (agent.acpTransport ?? 'websocket') : 'websocket',
        acpCommand: agent.acpCommand ?? '',
        acpArgsText: '',
      });
    };

    const saveAgentForm = async () => {
      if (!form || saving) return;
      setSaving(true);
      const savedId = form.id.trim();
      try {
        const acpArgs =
          form.kind === 'acp' && form.acpTransport === 'stdio' && form.acpArgsText.trim()
            ? form.acpArgsText.trim().split(/\s+/).filter(Boolean)
            : undefined;
        const { agents } = await apiPost<{ agents: AgentSummary[] }>(ctx, '/api/dsh-knot/agent-save', {
          id: savedId,
          kind: form.kind,
          transport: form.transport,
          endpoint: form.transport === 'direct' ? form.endpoint.trim() : undefined,
          host: form.transport === 'local' ? form.host.trim() : undefined,
          port: form.transport === 'local' ? form.port.trim() || '' : undefined,
          token: form.token,
          clearToken: form.clearToken,
          model: form.model,
          acpTransport: form.kind === 'acp' ? form.acpTransport : undefined,
          acpCommand: form.kind === 'acp' && form.acpTransport === 'stdio' ? form.acpCommand : undefined,
          ...(acpArgs ? { acpArgs } : {}),
        });
        setState((prev) =>
          prev ? { ...prev, agents, jobs: prev.jobs.filter((job) => job.agentId !== savedId) } : prev,
        );
        setForm(null);
        showToast(t('savedAgentToast'));
        await refreshState();
        void runDoctorAll(savedId);
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err));
      } finally {
        setSaving(false);
      }
    };

    const removeAgent = async (id: string) => {
      if (confirmDeleteId !== id) {
        setConfirmDeleteId(id);
        return;
      }
      setConfirmDeleteId(null);
      try {
        const { agents } = await apiPost<{ agents: AgentSummary[] }>(ctx, '/api/dsh-knot/agent-delete', { id });
        setState((prev) => (prev ? { ...prev, agents, jobs: prev.jobs.filter((job) => job.agentId !== id) } : prev));
        setExpandedDoctor((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        showToast(t('deletedAgentToast'));
        await refreshState();
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err));
      }
    };

    const copyYaml = () => {
      const host = state?.mcp.address?.host ?? '127.0.0.1';
      const port = state?.mcp.address?.port ?? 19400;
      const yaml = `mcp_servers:\n  dsh:\n    url: http://${host}:${port}/mcp\n    headers:\n      Authorization: Bearer \${env:DSH_KNOT_TOKEN}\n    trust: untrusted`;
      void navigator.clipboard?.writeText(yaml);
      showToast(t('copiedYaml'));
    };

    const agents = state?.agents ?? [];
    const jobs = state?.jobs ?? [];
    const verifiedCount = agents.filter((a) => a.connection?.status === 'connected').length;
    const pendingApprovals = jobs.filter((j) => j.pendingApproval && j.status === 'running');
    const runningJobs = jobs.filter(isRunning);
    const sharedCount = state?.mcp.allowSessions.length ?? 0;

    const chatAgent = agents.find((agent) => agent.id === chatAgentId);
    if (chatAgent) {
      return h(Chat, {
        key: chatAgent.revision,
        agent: chatAgent,
        agents,
        jobs,
        lang,
        t,
        onAgentChange: setChatAgentId,
        onClose: () => setChatAgentId(''),
        refreshState,
      });
    }

    const allConnected = agents.length > 0 && verifiedCount === agents.length;

    return h(
      'div',
      { className: 'dk-root dk-page' },
      toast ? h('div', { className: 'dk-toast', role: 'status' }, toast) : null,
      h(
        'div',
        { className: 'dk-wrap' },
        // Clean Native Topbar
        h(
          'header',
          { className: 'dk-topbar' },
          h(
            'div',
            { className: 'dk-topbar-left' },
            h('h1', { className: 'dk-title' }, t('title')),
            h(
              'div',
              { className: 'dk-summary-inline' },
              h(
                'span',
                { className: 'dk-summary-item' },
                h('span', { className: allConnected ? 'dk-dot dk-dot-ok' : 'dk-dot', 'aria-hidden': true }),
                `${verifiedCount}/${agents.length} ${t('statusConnected')}`,
              ),
              pendingApprovals.length
                ? h(
                    'span',
                    { className: 'dk-summary-item dk-summary-warn' },
                    h('span', { className: 'dk-dot dk-dot-warn', 'aria-hidden': true }),
                    `${pendingApprovals.length} ${t('kpiPending')}`,
                  )
                : null,
              runningJobs.length
                ? h(
                    'span',
                    { className: 'dk-summary-item' },
                    h('span', { className: 'dk-dot dk-dot-live', 'aria-hidden': true }),
                    `${runningJobs.length} ${t('kpiRunning')}`,
                  )
                : null,
              state?.mcp.enabled && state.mcp.address
                ? h(
                    'span',
                    { className: 'dk-summary-item dk-mono', style: { fontSize: '11.5px' } },
                    `MCP ${state.mcp.address.host}:${state.mcp.address.port}`,
                  )
                : null,
            ),
          ),
          h(
            'div',
            { className: 'dk-topbar-right' },
            h(
              'button',
              {
                type: 'button',
                className: 'dk-btn dk-btn-sm dk-btn-ghost',
                disabled: checkingDoctor,
                onClick: () => void runDoctorAll(),
              },
              icons.refresh(checkingDoctor, 13),
              checkingDoctor ? t('checking') : t('checkAll'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dk-btn dk-btn-sm dk-btn-ghost dk-mono',
                onClick: () => setLang((cur) => (cur === 'zh-CN' ? 'en' : 'zh-CN')),
              },
              lang === 'zh-CN' ? 'EN' : '中',
            ),
            h(
              'button',
              { type: 'button', className: 'dk-btn dk-btn-primary', onClick: openAddForm },
              icons.plus(13),
              t('addAgent').replace(/^\+\s*/, ''),
            ),
          ),
        ),
        error ? h('div', { className: 'dk-errbox', role: 'alert' }, error) : null,
        // Active Approvals & Running Jobs — only shown when something actually needs attention
        runningJobs.length > 0
          ? h(
              'section',
              null,
              h('div', { className: 'dk-group-head' }, h('span', { className: 'dk-group-label' }, t('attentionTitle'))),
              h(
                'div',
                { className: 'dk-list' },
                runningJobs.map((job) =>
                  job.pendingApproval
                    ? h(
                        'div',
                        { key: job.id, className: 'dk-job-row' },
                        h(
                          'div',
                          { className: 'dk-job-top' },
                          h(
                            'div',
                            { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
                            h('span', { className: 'dk-dot dk-dot-warn', 'aria-hidden': true }),
                            h('strong', { style: { fontSize: '13px' } }, `${job.agentId} · ${t('wantsApproval')}`),
                          ),
                          h(
                            'div',
                            { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
                            agents.find((a) => a.id === job.agentId)?.supportsRespond === false
                              ? h('span', { className: 'dk-muted' }, t('approveRemotely'))
                              : (job.pendingApproval.choices.length
                                  ? job.pendingApproval.choices
                                  : ['approve', 'deny']
                                ).map((choice) =>
                                  h(
                                    'button',
                                    {
                                      key: choice,
                                      type: 'button',
                                      className: /deny|reject|no/i.test(choice)
                                        ? 'dk-btn dk-btn-sm dk-btn-danger-armed'
                                        : 'dk-btn dk-btn-sm dk-btn-primary',
                                      onClick: () =>
                                        void respondApproval(job.id, job.pendingApproval?.requestId ?? '', choice),
                                    },
                                    choice,
                                  ),
                                ),
                          ),
                        ),
                        h(
                          'pre',
                          { className: 'dk-pre dk-mono' },
                          job.pendingApproval.text ?? job.pendingApproval.requestId,
                        ),
                      )
                    : h(
                        'div',
                        { key: job.id, className: 'dk-job-row' },
                        h(
                          'div',
                          { className: 'dk-job-top' },
                          h(
                            'div',
                            { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
                            h('span', { className: 'dk-dot dk-dot-live', 'aria-hidden': true }),
                            h('span', { style: { fontWeight: 500 } }, `${job.agentId} · ${t('runningNow')}`),
                          ),
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'dk-btn dk-btn-sm dk-btn-danger-armed',
                              onClick: () => void cancelJob(job.id),
                            },
                            icons.stop(11),
                            t('stopTask'),
                          ),
                        ),
                        job.text ? h('div', { className: 'dk-muted dk-mono' }, job.text.slice(-180)) : null,
                      ),
                ),
              ),
            )
          : null,
        // Connected Remote Agents — Tailscale/Linear grouped list
        h(
          'section',
          null,
          h(
            'div',
            { className: 'dk-list' },
            agents.length === 0
              ? h(
                  'div',
                  { className: 'dk-empty' },
                  h('div', { style: { maxWidth: '420px' } }, t('agentsEmpty')),
                  h(
                    'button',
                    { type: 'button', className: 'dk-btn dk-btn-primary', onClick: openAddForm },
                    icons.plus(13),
                    t('addAgent').replace(/^\+\s*/, ''),
                  ),
                )
              : agents.map((agent) => {
                  const steps = agent.connection?.steps;
                  const connStatus = agent.connection?.status ?? 'unverified';
                  const isOpen = Boolean(expandedDoctor[agent.id]);
                  const isDeleteArmed = confirmDeleteId === agent.id;
                  const endpoint = agent.acpTransport === 'stdio' ? 'Local stdio' : formatDirectEndpoint(agent);
                  const dotClass =
                    connStatus === 'connected'
                      ? 'dk-dot dk-dot-ok'
                      : connStatus === 'error'
                        ? 'dk-dot dk-dot-err'
                        : 'dk-dot';
                  return h(
                    'div',
                    { key: agent.id, className: 'dk-agent-row' },
                    h(
                      'div',
                      { className: 'dk-agent-main' },
                      h(
                        'div',
                        { className: 'dk-agent-left' },
                        h(
                          'span',
                          {
                            className: 'dk-agent-dot-wrap',
                            title: t(
                              connStatus === 'connected'
                                ? 'statusConnected'
                                : connStatus === 'error'
                                  ? 'statusFailed'
                                  : 'statusUnverified',
                            ),
                          },
                          h('span', { className: dotClass, 'aria-hidden': true }),
                        ),
                        h(
                          'div',
                          { className: 'dk-agent-info' },
                          h(
                            'div',
                            { className: 'dk-agent-title-line' },
                            h('span', { className: 'dk-agent-name' }, agent.id),
                            h('span', { className: 'dk-agent-kind dk-mono' }, agent.kind),
                            agent.hasToken
                              ? h('span', { className: 'dk-agent-key', title: t('tokenConfigured') }, icons.key(12))
                              : null,
                          ),
                          h('div', { className: 'dk-agent-sub dk-mono', title: endpoint }, endpoint),
                        ),
                      ),
                      h(
                        'div',
                        { className: 'dk-agent-actions' },
                        steps
                          ? h(
                              'button',
                              {
                                type: 'button',
                                className: 'dk-btn dk-btn-sm dk-btn-ghost',
                                onClick: () => setExpandedDoctor((prev) => ({ ...prev, [agent.id]: !prev[agent.id] })),
                              },
                              isOpen ? t('hide') : t('details'),
                              icons.chevronDown(12, isOpen),
                            )
                          : null,
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'dk-btn dk-btn-icon dk-btn-ghost',
                            title: t('retest'),
                            'aria-label': t('retest'),
                            disabled: checkingDoctor,
                            onClick: () => void runDoctorAll(agent.id),
                          },
                          icons.refresh(false, 13),
                        ),
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'dk-btn dk-btn-icon dk-btn-ghost',
                            title: t('editAgent'),
                            'aria-label': t('editAgent'),
                            onClick: () => openEditForm(agent),
                          },
                          icons.edit(13),
                        ),
                        h(
                          'button',
                          {
                            type: 'button',
                            className: isDeleteArmed
                              ? 'dk-btn dk-btn-sm dk-btn-danger-armed'
                              : 'dk-btn dk-btn-icon dk-btn-danger',
                            title: t('deleteAgent'),
                            'aria-label': t('deleteAgent'),
                            onClick: () => void removeAgent(agent.id),
                            onBlur: () => setConfirmDeleteId((cur) => (cur === agent.id ? null : cur)),
                          },
                          icons.trash(13),
                          isDeleteArmed ? t('confirmDeleteAgent') : null,
                        ),
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'dk-btn dk-btn-sm dk-btn-chat-go',
                            onClick: () => setChatAgentId(agent.id),
                          },
                          t('chatWithAgent'),
                        ),
                      ),
                    ),
                    connStatus === 'error' && agent.connection?.error && !isOpen
                      ? h(
                          'div',
                          { className: 'dk-row-err', role: 'alert' },
                          h(
                            'div',
                            { className: 'dk-mono', style: { fontWeight: 500 } },
                            `${agent.connection.failedStep ?? 'check'}: ${agent.connection.error}`,
                          ),
                          agent.connection.hint ? h('div', { className: 'dk-muted' }, agent.connection.hint) : null,
                        )
                      : null,
                    isOpen && steps
                      ? h(
                          'div',
                          { className: 'dk-diag' },
                          ...steps.flatMap((step) => [
                            h(
                              'span',
                              {
                                key: `s-${step.name}`,
                                className: `dk-diag-step dk-mono ${step.ok ? 'dk-diag-ok' : 'dk-diag-err'}`,
                              },
                              step.ok ? icons.check(12) : icons.alert(12),
                              step.name,
                            ),
                            h('span', { key: `d-${step.name}`, className: 'dk-diag-detail dk-mono' }, step.detail),
                            step.hint
                              ? h('div', { key: `h-${step.name}`, className: 'dk-diag-hint' }, `→ ${step.hint}`)
                              : null,
                          ]),
                        )
                      : null,
                  );
                }),
          ),
        ),
        // Shared Local Chats (Read-only MCP) — quiet 1-line footnote when off, grouped list when on
        !state?.mcp.enabled
          ? h(
              'div',
              { className: 'dk-mcp-footnote' },
              icons.shield(13),
              h('span', null, `${t('shareHeading')} · ${t('mcpDisabled')}`),
            )
          : h(
              'section',
              null,
              h(
                'div',
                { className: 'dk-group-head' },
                h('span', { className: 'dk-group-label' }, `${t('shareHeading')} (${sharedCount})`),
                h(
                  'button',
                  { type: 'button', className: 'dk-btn dk-btn-sm dk-btn-ghost', onClick: copyYaml },
                  icons.copy(12),
                  t('copyYaml'),
                ),
              ),
              h(
                'div',
                { className: 'dk-list' },
                state.mcp.localSessions.length === 0
                  ? h('div', { className: 'dk-empty', style: { padding: '24px' } }, t('noLocalSessions'))
                  : state.mcp.localSessions.map((item) =>
                      h(
                        'div',
                        { key: item.sessionId, className: 'dk-mcp-row' },
                        h(
                          'div',
                          { style: { minWidth: 0 } },
                          h(
                            'div',
                            {
                              style: {
                                fontWeight: 500,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              },
                            },
                            item.title ?? item.sessionId,
                          ),
                          h('div', { className: 'dk-muted dk-mono', style: { fontSize: '11.5px' } }, item.sessionId),
                        ),
                        h(
                          'button',
                          {
                            type: 'button',
                            className: item.shared ? 'dk-switch is-on' : 'dk-switch is-off',
                            onClick: () => void toggleShare(item.sessionId, !item.shared),
                          },
                          h('span', {
                            className: item.shared ? 'dk-dot dk-dot-ok' : 'dk-dot',
                            'aria-hidden': true,
                          }),
                          item.shared ? t('sharedOn') : t('sharedOff'),
                        ),
                      ),
                    ),
              ),
            ),
        form
          ? h(
              'div',
              { className: 'dk-modal-bg', onClick: () => setForm(null) },
              h(
                'div',
                {
                  className: 'dk-modal',
                  role: 'dialog',
                  'aria-modal': true,
                  onClick: (e: { stopPropagation?: () => void }) => e.stopPropagation?.(),
                },
                h(
                  'div',
                  { className: 'dk-modal-head' },
                  h('h3', { className: 'dk-modal-title' }, t(form.editing ? 'modalEditTitle' : 'modalAddTitle')),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dk-btn dk-btn-sm dk-btn-ghost',
                      'aria-label': t('closeBtn'),
                      onClick: () => setForm(null),
                    },
                    icons.close(15),
                  ),
                ),
                h(
                  'div',
                  { className: 'dk-field-row' },
                  h(
                    'label',
                    { className: 'dk-field' },
                    h('span', null, t('fieldId')),
                    h('input', {
                      className: 'dk-input dk-mono',
                      disabled: form.editing,
                      placeholder: 'hermes-gpu',
                      value: form.id,
                      onInput: (e: { target: { value: string } }) =>
                        setForm((cur) => (cur ? { ...cur, id: e.target.value } : null)),
                    }),
                  ),
                  h(
                    'label',
                    { className: 'dk-field' },
                    h('span', null, t('fieldKind')),
                    h(
                      'select',
                      {
                        className: 'dk-input',
                        value: form.kind,
                        onChange: (e: { target: { value: string } }) => {
                          const nextKind = e.target.value as AgentFormState['kind'];
                          setForm((cur) =>
                            cur
                              ? {
                                  ...cur,
                                  kind: nextKind,
                                  port: cur.port === defaultPortForKind(cur.kind) ? '' : cur.port,
                                }
                              : null,
                          );
                        },
                      },
                      h('option', { value: 'acp' }, 'ACP v1'),
                      h('option', { value: 'hermes' }, 'Hermes'),
                      h('option', { value: 'openclaw' }, 'OpenClaw'),
                      h('option', { value: 'dsh' }, 'Remote DSH'),
                    ),
                  ),
                ),
                h(
                  'div',
                  { className: 'dk-field-row' },
                  h(
                    'label',
                    { className: 'dk-field' },
                    h('span', null, t('fieldTransport')),
                    h(
                      'select',
                      {
                        className: 'dk-input',
                        value: form.transport,
                        onChange: (e: { target: { value: string } }) =>
                          setForm((cur) =>
                            cur
                              ? {
                                  ...cur,
                                  transport: e.target.value as AgentFormState['transport'],
                                  acpTransport: e.target.value === 'direct' ? 'websocket' : cur.acpTransport,
                                }
                              : null,
                          ),
                      },
                      h('option', { value: 'direct' }, t('transportDirectOpt')),
                      h('option', { value: 'local' }, t('transportLocalOpt')),
                    ),
                  ),
                  form.transport === 'local' && !(form.kind === 'acp' && form.acpTransport === 'stdio')
                    ? h(
                        'label',
                        { className: 'dk-field' },
                        h('span', null, t('fieldPort')),
                        h('input', {
                          className: 'dk-input dk-mono',
                          type: 'number',
                          placeholder: defaultPortForKind(form.kind),
                          value: form.port,
                          onInput: (e: { target: { value: string } }) =>
                            setForm((cur) => (cur ? { ...cur, port: e.target.value } : null)),
                        }),
                      )
                    : h('div', null),
                ),
                form.transport === 'direct'
                  ? h(
                      'div',
                      { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
                      h(
                        'div',
                        { className: 'dk-infobox' },
                        t(
                          form.kind === 'hermes'
                            ? 'hermesSetupTip'
                            : form.kind === 'openclaw'
                              ? 'openclawSetupTip'
                              : 'directSetupTip',
                        ),
                      ),
                      h(
                        'label',
                        { className: 'dk-field' },
                        h('span', null, t('fieldEndpoint')),
                        h('input', {
                          className: 'dk-input dk-mono',
                          placeholder: 'https://my-vm.tailnet.ts.net',
                          value: form.endpoint,
                          onInput: (e: { target: { value: string } }) =>
                            setForm((cur) => (cur ? { ...cur, endpoint: e.target.value } : null)),
                        }),
                      ),
                    )
                  : form.kind === 'acp' && form.acpTransport === 'stdio'
                    ? null
                    : h(
                        'label',
                        { className: 'dk-field' },
                        h('span', null, t('fieldHost')),
                        h('input', {
                          className: 'dk-input dk-mono',
                          placeholder: '127.0.0.1',
                          value: form.host,
                          onInput: (e: { target: { value: string } }) =>
                            setForm((cur) => (cur ? { ...cur, host: e.target.value } : null)),
                        }),
                      ),
                form.kind === 'acp' && form.transport === 'local'
                  ? h(
                      'div',
                      { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
                      h(
                        'div',
                        { className: 'dk-field-row' },
                        h(
                          'label',
                          { className: 'dk-field' },
                          h('span', null, t('fieldAcpTransport')),
                          h(
                            'select',
                            {
                              className: 'dk-input',
                              value: form.acpTransport,
                              onChange: (e: { target: { value: string } }) =>
                                setForm((cur) =>
                                  cur ? { ...cur, acpTransport: e.target.value as 'websocket' | 'stdio' } : null,
                                ),
                            },
                            h('option', { value: 'websocket' }, 'WebSocket'),
                            h('option', { value: 'stdio' }, 'stdio'),
                          ),
                        ),
                        form.acpTransport === 'stdio'
                          ? h(
                              'label',
                              { className: 'dk-field' },
                              h('span', null, t('fieldAcpCommand')),
                              h('input', {
                                className: 'dk-input dk-mono',
                                placeholder: 'hermes',
                                value: form.acpCommand,
                                onInput: (e: { target: { value: string } }) =>
                                  setForm((cur) => (cur ? { ...cur, acpCommand: e.target.value } : null)),
                              }),
                            )
                          : h('div', null),
                      ),
                      form.acpTransport === 'stdio'
                        ? h(
                            'label',
                            { className: 'dk-field' },
                            h('span', null, t('fieldAcpArgs')),
                            h('input', {
                              className: 'dk-input dk-mono',
                              placeholder: 'acp',
                              value: form.acpArgsText,
                              onInput: (e: { target: { value: string } }) =>
                                setForm((cur) => (cur ? { ...cur, acpArgsText: e.target.value } : null)),
                            }),
                          )
                        : null,
                    )
                  : null,
                h(
                  'label',
                  { className: 'dk-field' },
                  h('span', null, t('fieldToken')),
                  h('input', {
                    className: 'dk-input dk-mono',
                    type: 'password',
                    disabled: form.clearToken,
                    placeholder: form.editing ? t('fieldTokenKeep') : '••••••••',
                    value: form.token,
                    onInput: (e: { target: { value: string } }) =>
                      setForm((cur) => (cur ? { ...cur, token: e.target.value } : null)),
                  }),
                ),
                form.editing && form.hasToken
                  ? h(
                      'label',
                      { style: { display: 'flex', alignItems: 'center', gap: '7px', fontSize: '12px' } },
                      h('input', {
                        type: 'checkbox',
                        checked: form.clearToken,
                        onChange: (e: { target: { checked: boolean } }) =>
                          setForm((cur) =>
                            cur
                              ? {
                                  ...cur,
                                  clearToken: Boolean(e.target.checked),
                                  token: e.target.checked ? '' : cur.token,
                                }
                              : null,
                          ),
                      }),
                      h('span', null, t('fieldClearToken')),
                    )
                  : null,
                h(
                  'label',
                  { className: 'dk-field' },
                  h('span', null, t('fieldModel')),
                  h('input', {
                    className: 'dk-input dk-mono',
                    placeholder: 'optional',
                    value: form.model,
                    onInput: (e: { target: { value: string } }) =>
                      setForm((cur) => (cur ? { ...cur, model: e.target.value } : null)),
                  }),
                ),
                h(
                  'div',
                  { className: 'dk-modal-foot' },
                  h(
                    'button',
                    { type: 'button', className: 'dk-btn', disabled: saving, onClick: () => setForm(null) },
                    t('cancelBtn'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dk-btn dk-btn-primary',
                      disabled: saving,
                      onClick: () => void saveAgentForm(),
                    },
                    saving ? t('savingAgent') : t('saveAgent'),
                  ),
                ),
              ),
            )
          : null,
      ),
    );
  };
}

function makeIcon(React: ReactModule) {
  return function KnotIcon(props: Record<string, unknown>) {
    const size = typeof props.size === 'number' ? props.size : 16;
    return React.createElement(
      'svg',
      {
        xmlns: 'http://www.w3.org/2000/svg',
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        className: 'dk-sidebar-icon',
        'aria-hidden': true,
      },
      React.createElement('path', {
        d: 'M7.4 13.5H6a3 3 0 0 1-3-3v-2a3 3 0 0 1 3-3h5.5a3 3 0 0 1 3 3v2a3 3 0 0 1-2.9 3M12.4 10.5a3 3 0 0 0-2.9 3v2a3 3 0 0 0 3 3H18a3 3 0 0 0 3-3v-2a3 3 0 0 0-3-3h-1.4',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: '1.75',
        strokeLinecap: 'round',
      }),
    );
  };
}

export const name = NS;
export const inject = ['slots'];

export function apply(ctx: ClientContext): void {
  const React = require('react') as ReactModule;
  const locale = getClientService<ClientLocale>(ctx, 'locale');
  const slots = getClientService<ClientSlots>(ctx, 'slots');
  ctx.effect?.(() => injectStyles(), 'dsh-knot: styles');
  ctx.effect?.(() => locale?.register?.(NS, DICTS), 'dsh-knot: locale');
  const t = locale?.bind?.(NS) ?? ((key: string) => DICTS['zh-CN']?.[key] ?? key);
  const primitives = require('@deepseek-ai/dsh-client-ui-primitives') as ChatPrimitives;
  const Dashboard = makeDashboard(React, ctx, primitives);
  const Icon = makeIcon(React);

  ctx.effect?.(
    () =>
      slots?.inject?.(
        'main',
        () =>
          slots?.register?.({ name: 'main', key: PANEL_ID, locale: NS }, () => React.createElement(Dashboard)) ??
          (() => {}),
      ),
    'dsh-knot: main panel',
  );
  ctx.effect?.(
    () =>
      slots?.inject?.(
        'sidebar.panellist',
        () =>
          slots?.register?.(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 25, label: () => t('title'), locale: NS },
            (props) => React.createElement(Icon, props),
          ) ?? (() => {}),
      ),
    'dsh-knot: sidebar entry',
  );
}
