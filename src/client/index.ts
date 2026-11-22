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
  kind: 'hermes' | 'openclaw' | 'dsh' | 'acp';
  transport?: 'ssh' | 'direct' | 'local';
  host?: string;
  basePath?: string;
  ssh?: string;
  sshHost?: string;
  sshPort?: number;
  sshUser?: string;
  sshIdentityFile?: string;
  port?: number;
  tls?: boolean;
  acpTransport?: 'websocket' | 'stdio';
  acpCommand?: string;
  acpRuntimeUser?: string;
  acpLauncher?: string;
  model?: string;
  hasToken?: boolean;
  supportsRespond?: boolean;
  connection?: AgentConnectionState;
}

interface LocalSshKeyItem {
  path: string;
  name: string;
  permissionsWarning?: string;
}

interface AgentFormState {
  editing: boolean;
  hasToken: boolean;
  clearToken: boolean;
  id: string;
  kind: 'hermes' | 'openclaw' | 'dsh' | 'acp';
  transport: 'ssh' | 'direct' | 'local';
  endpoint: string;
  ssh: string;
  sshHost: string;
  sshPort: string;
  sshUser: string;
  sshIdentityFile: string;
  host: string;
  port: string;
  tls: boolean;
  token: string;
  model: string;
  acpTransport: 'websocket' | 'stdio';
  acpCommand: string;
  acpArgsText: string;
  acpRuntimeUser: string;
  acpLauncher: string;
}

interface JobSummary {
  id: string;
  agentId: string;
  sessionId?: string;
  prompt?: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  createdAt: number;
  updatedAt: number;
  text: string;
  error?: string;
  pendingApproval?: { requestId: string; choices: string[]; text?: string };
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

const NS = 'dsh-knot';
const PANEL_ID = 'dsh-knot';
const STYLE_ID = 'dsh-knot-client-styles';

const DICTS: Record<string, Record<string, string>> = {
  'zh-CN': {
    title: '远端助手',
    checkAll: '检测全部连接',
    checking: '检测中…',
    refresh: '刷新',
    filterAll: '全部助手',
    filterSsh: 'SSH',
    filterDirect: '直连/本地',
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
    transportSshOpt: 'SSH（免公网端口 / 备选）',
    transportLocalOpt: '本机 Local (127.0.0.1)',
    directSetupTip:
      '推荐在云主机保持网关仅监听 127.0.0.1，通过 tailscale serve --bg http://127.0.0.1:8642 转发为私网 HTTPS 地址并填入下方。',
    fieldEndpoint: '私网 HTTPS / HTTP 端点地址',
    fieldSshHost: 'SSH 主机地址（IP 或域名）',
    fieldSshPort: 'SSH 端口（默认 22）',
    fieldSshUser: 'SSH 登录用户（如 ubuntu / ec2-user）',
    fieldSshKey: '本地 PEM / 私钥路径（仅保留在本机）',
    fieldSshKeyPick: '从本机已知密钥选择…',
    fieldSshKeyBrowse: '选择文件',
    fieldSsh: 'OpenSSH 别名（可选，来自 ~/.ssh/config）',
    fieldHost: '主机地址（IP 或 Tailscale 域名）',
    fieldPort: '网关端口（留空按协议或 HTTPS 443 默认）',
    fieldTls: '启用 TLS (HTTPS / WSS)',
    fieldToken: 'Gateway Token / API Key（独立保存，无需环境变量）',
    fieldTokenKeep: '留空则保留当前已保存的 Token',
    fieldClearToken: '清空已保存的 Token',
    fieldModel: '默认模型（可选）',
    fieldAcpTransport: 'ACP 传输方式',
    fieldAcpCommand: 'ACP stdio 命令（如 hermes 或绝对路径）',
    fieldAcpArgs: 'ACP 命令参数（空格分隔，如 acp）',
    fieldAcpRuntimeUser: 'ACP 运行账号（可选，如 root）',
    fieldAcpRuntimeTip:
      '若云主机 SSH 登录账号（如 ubuntu）与 Hermes 安装账号（如 sudo 安装的 root）不同，请填写运行账号或服务端已授权的启动器。',
    fieldAcpLauncher: '服务端授权启动器（可选，如 sudo -n /usr/local/bin/hermes-acp）',
    tokenConfigured: '已配密钥',
    savingAgent: '保存中…',
    savedAgentToast: '已保存配置，正在验证连接…',
    deletedAgentToast: '已移除该助手',
    viewHistory: '看历史',
    chatWithAgent: '对话',
    details: '连接详情',
    retest: '重测',
    hide: '收起',
    historyHeading: '远端历史对话',
    selectAgentPrompt: '选择一个助手加载其远端历史会话',
    loadingHistory: '正在加载远端会话…',
    historyErrorTitle: '加载远端历史会话失败',
    retry: '重试',
    noHistory: '该助手暂无可列出的历史会话',
    searchPlaceholder: '搜索标题或会话 ID…',
    loadMore: '加载更多',
    resumeInPanel: '继续对话',
    continuePrompt: '复制指令',
    copiedContinue: '已复制，粘贴到 dsh 主对话框即可继续',
    chatHeading: '直接对话',
    chatSelectAgent: '选择远端助手开始或继续对话',
    chatNewSession: '新建对话',
    chatResuming: '继续会话',
    chatEmpty: '在这里直接向远端助手发消息，或从下方历史会话点击「继续对话」。',
    chatPlaceholder: '输入消息，按 Enter 发送（Shift+Enter 换行）…',
    chatSend: '发送',
    chatSending: '发送中…',
    chatFailed: '执行失败',
    chatCancelled: '已停止',
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
    checkAll: 'Test all connections',
    checking: 'Testing…',
    refresh: 'Refresh',
    filterAll: 'All Agents',
    filterSsh: 'SSH',
    filterDirect: 'Direct / Local',
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
    transportSshOpt: 'SSH (Fallback / No public port)',
    transportLocalOpt: 'Local (127.0.0.1)',
    directSetupTip:
      'Keep the gateway bound to 127.0.0.1 on the VM and forward via Tailscale Serve (tailscale serve --bg http://127.0.0.1:8642), then enter the HTTPS URL and token below.',
    fieldEndpoint: 'Private HTTPS / HTTP Endpoint URL',
    fieldSshHost: 'SSH Host (IP or domain)',
    fieldSshPort: 'SSH Port (default 22)',
    fieldSshUser: 'SSH Login User (e.g. ubuntu, ec2-user)',
    fieldSshKey: 'Local PEM / Private Key Path (stays on-device)',
    fieldSshKeyPick: 'Pick from detected local keys…',
    fieldSshKeyBrowse: 'Browse…',
    fieldSsh: 'OpenSSH Alias (optional, from ~/.ssh/config)',
    fieldHost: 'Host (IP or Tailscale hostname)',
    fieldPort: 'Gateway Port (blank for protocol default or 443 for HTTPS)',
    fieldTls: 'Use TLS (HTTPS / WSS)',
    fieldToken: 'Gateway Token / API Key (stored per agent, 0600)',
    fieldTokenKeep: 'Leave blank to keep existing token',
    fieldClearToken: 'Clear saved token',
    fieldModel: 'Model override (optional)',
    fieldAcpTransport: 'ACP Transport',
    fieldAcpCommand: 'ACP stdio command (e.g. hermes or full path)',
    fieldAcpArgs: 'ACP args (space-separated, e.g. acp)',
    fieldAcpRuntimeUser: 'ACP Runtime User (optional, e.g. root)',
    fieldAcpRuntimeTip:
      'Distinguish from SSH login user if Hermes was installed under root via sudo. Uses sudo -n -u <user> or a server-approved launcher.',
    fieldAcpLauncher: 'Server-approved launcher (optional, e.g. sudo -n /usr/local/bin/hermes-acp)',
    tokenConfigured: 'Token set',
    savingAgent: 'Saving…',
    savedAgentToast: 'Agent saved — verifying connection…',
    deletedAgentToast: 'Agent removed',
    viewHistory: 'History',
    chatWithAgent: 'Chat',
    details: 'Details',
    retest: 'Retest',
    hide: 'Hide',
    historyHeading: 'Remote Conversation History',
    selectAgentPrompt: 'Select an agent to load its remote sessions',
    loadingHistory: 'Loading remote sessions…',
    historyErrorTitle: 'Failed to load remote sessions',
    retry: 'Retry',
    noHistory: 'No remote sessions returned by this agent',
    searchPlaceholder: 'Search title or session ID…',
    loadMore: 'Load more',
    resumeInPanel: 'Resume',
    continuePrompt: 'Copy prompt',
    copiedContinue: 'Copied — paste into dsh main chat to continue',
    chatHeading: 'Direct Chat',
    chatSelectAgent: 'Select a remote agent to start or resume a conversation',
    chatNewSession: 'New chat',
    chatResuming: 'Resuming session',
    chatEmpty: 'Send a message here to start a remote conversation, or click "Resume" on any session below.',
    chatPlaceholder: 'Message remote agent… (Enter to send, Shift+Enter for newline)',
    chatSend: 'Send',
    chatSending: 'Sending…',
    chatFailed: 'Failed',
    chatCancelled: 'Stopped',
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
.dk-root { padding: 16px 20px; height: 100%; overflow-y: auto; box-sizing: border-box; background: var(--dsw-static-neutral-bluish-75, var(--dsw-alias-bg-layer-0, #f5f6f8)); color: var(--dsw-alias-label-primary, #111827); font-size: 13px; }
body[data-ds-dark-theme] .dk-root { background: var(--dsw-alias-bg-layer-0, #0e1015); color: var(--dsw-alias-label-primary, #eef1f6); }
.dk-wrap { max-width: 1240px; margin: 0 auto; display: flex; flex-direction: column; gap: 14px; }
.dk-header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; }
.dk-header-left, .dk-header-right { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.dk-title { font-size: 16px; font-weight: 600; margin: 0 4px 0 0; }
.dk-capsule { display: inline-flex; align-items: center; gap: 6px; padding: 4px 11px; border-radius: 999px; font-size: 12px; background: var(--dsw-alias-bg-layer-1, #ffffff); border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.1)); color: var(--dsw-alias-label-secondary, #52525b); cursor: pointer; }
.dk-capsule:hover { color: var(--dsw-alias-label-primary, #111827); }
.dk-capsule-static { cursor: default; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.dk-seg-track { display: inline-flex; gap: 2px; padding: 2px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.05)); border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.08)); }
.dk-seg { border: 0; background: transparent; padding: 3px 10px; border-radius: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary, #52525b); cursor: pointer; }
.dk-seg-on { background: var(--dsw-alias-label-primary, #111827); color: var(--dsw-alias-bg-layer-1, #ffffff); font-weight: 500; }
.dk-card { background: var(--dsw-alias-bg-layer-1, #ffffff); border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.08)); border-radius: 12px; padding: 14px 16px; box-shadow: 0 1px 2px rgba(0,0,0,0.04); }
.dk-card-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; padding-bottom: 10px; margin-bottom: 12px; border-bottom: 1px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.07)); }
.dk-card-title { font-size: 13.5px; font-weight: 600; }
.dk-muted { font-size: 12px; color: var(--dsw-alias-label-secondary, #6b7280); }
.dk-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.dk-row1 { display: grid; grid-template-columns: 5fr 7fr; gap: 14px; }
.dk-row3 { display: grid; grid-template-columns: 7fr 5fr; gap: 14px; align-items: start; }
.dk-kpis { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.dk-kpi { text-align: center; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 14px 10px; }
.dk-kpi-num { font-size: 24px; font-weight: 700; font-variant-numeric: tabular-nums; margin: 4px 0 2px; }
.dk-agents-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.dk-subbox { background: var(--dsw-alias-bg-layer-2, #f8f9fb); border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.08)); border-radius: 10px; padding: 12px; }
.dk-warnbox { background: color-mix(in srgb, #f59e0b 9%, var(--dsw-alias-bg-layer-2, #f8f9fb)); border: 1px solid color-mix(in srgb, #f59e0b 35%, var(--dsw-alias-border-l2, rgba(0,0,0,0.1))); border-radius: 10px; padding: 12px; }
.dk-btn { border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.12)); background: var(--dsw-alias-bg-layer-1, #ffffff); color: inherit; border-radius: 8px; padding: 4px 10px; font-size: 12px; cursor: pointer; }
.dk-btn-primary { background: var(--dsw-alias-label-primary, #111827); color: var(--dsw-alias-bg-layer-1, #ffffff); border-color: transparent; font-weight: 500; }
.dk-btn-danger { color: #dc2626; border-color: transparent; background: transparent; }
.dk-btn-link { border: 0; background: transparent; color: var(--dsw-alias-brand-primary, #2563eb); padding: 2px 4px; font-size: 12px; font-weight: 500; cursor: pointer; }
.dk-pill-ok { background: color-mix(in srgb, #16a34a 14%, transparent); color: #15803d; padding: 2px 8px; border-radius: 999px; font-size: 11.5px; font-weight: 500; }
.dk-pill-err { background: color-mix(in srgb, #dc2626 14%, transparent); color: #dc2626; padding: 2px 8px; border-radius: 999px; font-size: 11.5px; font-weight: 500; }
.dk-pill-off { background: var(--dsw-alias-bg-layer-1, #ffffff); border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.12)); color: var(--dsw-alias-label-secondary, #6b7280); padding: 2px 8px; border-radius: 999px; font-size: 11.5px; }
.dk-errbox { background: color-mix(in srgb, #dc2626 8%, var(--dsw-alias-bg-layer-2, #f8f9fb)); border: 1px solid color-mix(in srgb, #dc2626 32%, var(--dsw-alias-border-l2, rgba(0,0,0,0.1))); border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; }
.dk-pre { margin: 8px 0 0; padding: 8px 10px; border-radius: 8px; background: var(--dsw-alias-bg-layer-1, #ffffff); border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.08)); font-size: 12px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
.dk-input { padding: 5px 10px; border-radius: 8px; font-size: 12px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.12)); background: var(--dsw-alias-bg-layer-2, #f8f9fb); color: inherit; outline: none; }
.dk-textarea { width: 100%; box-sizing: border-box; min-height: 64px; max-height: 180px; resize: vertical; padding: 8px 10px; border-radius: 8px; font-size: 12.5px; font-family: inherit; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.12)); background: var(--dsw-alias-bg-layer-2, #f8f9fb); color: inherit; outline: none; }
.dk-chat-log { display: flex; flex-direction: column; gap: 10px; max-height: 320px; overflow-y: auto; padding: 4px 2px; margin-bottom: 10px; }
.dk-chat-user { align-self: flex-end; max-width: 85%; background: var(--dsw-alias-label-primary, #111827); color: var(--dsw-alias-bg-layer-1, #ffffff); padding: 7px 11px; border-radius: 10px; font-size: 12.5px; white-space: pre-wrap; word-break: break-word; }
.dk-chat-bot { align-self: flex-start; max-width: 92%; background: var(--dsw-alias-bg-layer-2, #f8f9fb); border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.08)); padding: 8px 11px; border-radius: 10px; font-size: 12.5px; white-space: pre-wrap; word-break: break-word; }
.dk-list-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 9px 6px; border-bottom: 1px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.06)); }
.dk-list-row:last-child { border-bottom: 0; }
.dk-toast { position: fixed; top: 14px; left: 50%; transform: translateX(-50%); z-index: 9999; padding: 7px 14px; border-radius: 999px; font-size: 12px; background: var(--dsw-alias-label-primary, #111827); color: var(--dsw-alias-bg-layer-1, #ffffff); box-shadow: 0 4px 16px rgba(0,0,0,0.2); }
.dk-modal-bg { position: fixed; inset: 0; z-index: 9990; background: rgba(0,0,0,0.38); display: flex; align-items: center; justify-content: center; padding: 16px; }
.dk-modal { width: 100%; max-width: 540px; max-height: 90vh; overflow-y: auto; background: var(--dsw-alias-bg-layer-1, #ffffff); border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.12)); border-radius: 14px; padding: 18px 20px; box-shadow: 0 12px 36px rgba(0,0,0,0.22); display: flex; flex-direction: column; gap: 12px; }
.dk-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.dk-field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
@media (max-width: 960px) { .dk-row1, .dk-row3, .dk-agents-grid { grid-template-columns: 1fr; } }
`;

function injectStyles(): () => void {
  if (typeof document === 'undefined') return () => {};
  let el = document.getElementById(STYLE_ID);
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = CSS;
    document.head.appendChild(el);
  }
  return () => {
    document.getElementById(STYLE_ID)?.remove();
  };
}

function getClientService<T>(ctx: ClientContext, key: 'locale' | 'slots' | 'connection'): T | undefined {
  if (typeof ctx.get === 'function') return ctx.get(key) as T | undefined;
  return ctx[key] as T | undefined;
}

async function apiPost<T>(
  ctx: ClientContext,
  path: string,
  body: Record<string, unknown> = {},
  timeoutMs?: number,
): Promise<T> {
  const conn = getClientService<ClientConnection>(ctx, 'connection');
  const fetcher = typeof conn?.fetch === 'function' ? conn.fetch.bind(conn) : fetch;
  const controller = timeoutMs && typeof AbortController !== 'undefined' ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  try {
    const response = await fetcher(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(controller ? { signal: controller.signal } : {}),
    });
    const payload = (await response.json()) as { ok?: boolean; value?: T; error?: string };
    if (!response.ok || payload.ok === false) throw new Error(payload.error ?? `HTTP ${response.status}`);
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

function defaultPortForKind(kind: AgentFormState['kind'], tls?: boolean): string {
  if (tls) return '443';
  return kind === 'openclaw' ? '18789' : kind === 'dsh' ? '18790' : kind === 'acp' ? '18792' : '8642';
}

function formatDirectEndpoint(agent: AgentSummary): string {
  const scheme = agent.tls ? 'https' : 'http';
  const host = agent.host ?? '127.0.0.1';
  const port = agent.port;
  const omitPort = (agent.tls && port === 443) || (!agent.tls && port === 80) || !port;
  return `${scheme}://${host}${omitPort ? '' : `:${port}`}${agent.basePath ?? ''}`;
}

function makeDashboard(React: ReactModule, ctx: ClientContext) {
  const h = React.createElement;

  return function KnotDashboard() {
    const locale = getClientService<ClientLocale>(ctx, 'locale');
    const initialLang = String(locale?.current ?? 'zh').startsWith('en') ? 'en' : 'zh-CN';
    const [lang, setLang] = React.useState<'zh-CN' | 'en'>(initialLang);
    const [state, setState] = React.useState<KnotState | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [filter, setFilter] = React.useState<'all' | 'ssh' | 'direct'>('all');
    const [doctorByAgent, setDoctorByAgent] = React.useState<Record<string, DoctorStep[]>>({});
    const [expandedDoctor, setExpandedDoctor] = React.useState<Record<string, boolean>>({});
    const [checkingDoctor, setCheckingDoctor] = React.useState(false);
    const [historyAgent, setHistoryAgent] = React.useState('');
    const [historyItems, setHistoryItems] = React.useState<RemoteSessionItem[]>([]);
    const [historyLoading, setHistoryLoading] = React.useState(false);
    const [historyError, setHistoryError] = React.useState<string | null>(null);
    const [historySearch, setHistorySearch] = React.useState('');
    const [historyLimit, setHistoryLimit] = React.useState(6);
    const [chatAgent, setChatAgent] = React.useState('');
    const [chatSessionId, setChatSessionId] = React.useState('');
    const [chatSessionTitle, setChatSessionTitle] = React.useState('');
    const [chatInput, setChatInput] = React.useState('');
    const [chatSending, setChatSending] = React.useState(false);
    const [chatError, setChatError] = React.useState<string | null>(null);
    const [chatActiveJobId, setChatActiveJobId] = React.useState<string | null>(null);
    const [localKeys, setLocalKeys] = React.useState<LocalSshKeyItem[]>([]);
    const [toast, setToast] = React.useState<string | null>(null);
    const [form, setForm] = React.useState<AgentFormState | null>(null);
    const [saving, setSaving] = React.useState(false);
    const [confirmDeleteId, setConfirmDeleteId] = React.useState<string | null>(null);
    const toastTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const historySeq = React.useRef(0);
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
      try {
        const next = await apiPost<KnotState>(ctx, '/api/dsh-knot/state', {}, 15_000);
        setState(next);
        hasRunningRef.current = next.jobs.some((j) => j.status === 'running' || j.status === 'queued');
        setError(null);
        setDoctorByAgent((prev) => {
          let changed = false;
          const merged = { ...prev };
          for (const agent of next.agents) {
            if (agent.connection?.steps && !merged[agent.id]) {
              merged[agent.id] = agent.connection.steps;
              changed = true;
            }
          }
          return changed ? merged : prev;
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
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

    React.useEffect(() => {
      if (!chatAgent && state?.agents.length) {
        setChatAgent(state.agents[0]!.id);
      }
      if (chatActiveJobId && state?.jobs.length) {
        const active = state.jobs.find((j) => j.id === chatActiveJobId);
        if (active?.sessionId && active.agentId === chatAgent && !chatSessionId) {
          setChatSessionId(active.sessionId);
        }
      }
    }, [state, chatAgent, chatActiveJobId, chatSessionId]);

    const runDoctorAll = async (onlyAgent?: string) => {
      setCheckingDoctor(true);
      try {
        const result = await apiPost<{ agents: Array<{ id: string; steps: DoctorStep[] }> }>(
          ctx,
          '/api/dsh-knot/doctor',
          onlyAgent ? { agent: onlyAgent } : {},
          30_000,
        );
        const nextMap: Record<string, DoctorStep[]> = {};
        const nextOpen: Record<string, boolean> = {};
        for (const item of result.agents) {
          nextMap[item.id] = item.steps;
          nextOpen[item.id] = true;
        }
        setDoctorByAgent((prev) => ({ ...prev, ...nextMap }));
        setExpandedDoctor((prev) => ({ ...prev, ...nextOpen }));
        await refreshState();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setCheckingDoctor(false);
      }
    };

    const loadHistory = async (agentId: string) => {
      const seq = ++historySeq.current;
      setHistoryAgent(agentId);
      setHistoryLimit(6);
      setHistoryError(null);
      if (!agentId) {
        setHistoryItems([]);
        setHistoryLoading(false);
        return;
      }
      setHistoryLoading(true);
      try {
        const result = await apiPost<{ sessions: RemoteSessionItem[] }>(
          ctx,
          '/api/dsh-knot/sessions',
          { agentId },
          20_000,
        );
        if (historySeq.current !== seq) return;
        setHistoryItems(result.sessions ?? []);
        setHistoryError(null);
      } catch (err) {
        if (historySeq.current !== seq) return;
        setHistoryItems([]);
        setHistoryError(err instanceof Error ? err.message : String(err));
      } finally {
        if (historySeq.current === seq) setHistoryLoading(false);
      }
    };

    const sendChatMessage = async () => {
      const targetAgent = chatAgent || state?.agents[0]?.id || '';
      const message = chatInput.trim();
      if (!targetAgent || !message || chatSending) return;
      setChatSending(true);
      setChatError(null);
      try {
        const job = await apiPost<JobSummary>(
          ctx,
          '/api/dsh-knot/ask',
          {
            agentId: targetAgent,
            message,
            ...(chatSessionId ? { sessionId: chatSessionId } : {}),
          },
          15_000,
        );
        setChatInput('');
        setChatAgent(targetAgent);
        setChatActiveJobId(job.id);
        if (job.sessionId) setChatSessionId(job.sessionId);
        hasRunningRef.current = true;
        await refreshState();
      } catch (err) {
        setChatError(err instanceof Error ? err.message : String(err));
      } finally {
        setChatSending(false);
      }
    };

    const startChatWith = (agentId: string, sessionId = '', title = '') => {
      setChatAgent(agentId);
      setChatSessionId(sessionId);
      setChatSessionTitle(title);
      setChatActiveJobId(null);
      setChatError(null);
    };

    const loadLocalKeys = async () => {
      try {
        const result = await apiPost<{ keys: LocalSshKeyItem[] }>(ctx, '/api/dsh-knot/ssh-keys', {}, 5_000);
        setLocalKeys(result.keys ?? []);
      } catch {
        setLocalKeys([]);
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
      void loadLocalKeys();
      setForm({
        editing: false,
        hasToken: false,
        clearToken: false,
        id: '',
        kind: 'hermes',
        transport: 'direct',
        endpoint: '',
        ssh: '',
        sshHost: '',
        sshPort: '',
        sshUser: '',
        sshIdentityFile: '',
        host: '',
        port: '',
        tls: true,
        token: '',
        model: '',
        acpTransport: 'stdio',
        acpCommand: 'hermes',
        acpArgsText: 'acp',
        acpRuntimeUser: '',
        acpLauncher: '',
      });
    };

    const openEditForm = (agent: AgentSummary) => {
      void loadLocalKeys();
      const transport = agent.transport ?? 'ssh';
      setForm({
        editing: true,
        hasToken: Boolean(agent.hasToken),
        clearToken: false,
        id: agent.id,
        kind: agent.kind,
        transport,
        endpoint: transport === 'direct' ? formatDirectEndpoint(agent) : '',
        ssh: agent.ssh ?? '',
        sshHost: agent.sshHost ?? '',
        sshPort: agent.sshPort ? String(agent.sshPort) : '',
        sshUser: agent.sshUser ?? '',
        sshIdentityFile: agent.sshIdentityFile ?? '',
        host: agent.host ?? '127.0.0.1',
        port: agent.port ? String(agent.port) : '',
        tls: Boolean(agent.tls),
        token: '',
        model: agent.model ?? '',
        acpTransport: agent.acpTransport ?? 'websocket',
        acpCommand: agent.acpCommand ?? '',
        acpArgsText: '',
        acpRuntimeUser: agent.acpRuntimeUser ?? '',
        acpLauncher: agent.acpLauncher ?? '',
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
        await apiPost(ctx, '/api/dsh-knot/agent-save', {
          id: savedId,
          kind: form.kind,
          transport: form.transport,
          endpoint: form.transport === 'direct' ? form.endpoint.trim() : undefined,
          ssh: form.transport === 'ssh' ? form.ssh.trim() : undefined,
          sshHost: form.transport === 'ssh' ? form.sshHost.trim() : undefined,
          sshPort: form.transport === 'ssh' ? (form.sshPort.trim() ? Number(form.sshPort) : '') : undefined,
          sshUser: form.transport === 'ssh' ? form.sshUser.trim() : undefined,
          sshIdentityFile: form.transport === 'ssh' ? form.sshIdentityFile.trim() : undefined,
          host:
            form.transport === 'local'
              ? form.host.trim()
              : form.transport === 'direct' && !form.endpoint.trim()
                ? form.host.trim()
                : undefined,
          port: form.port.trim() ? Number(form.port) : undefined,
          tls: form.transport === 'direct' && !/^(https?|wss?):\/\//i.test(form.endpoint.trim()) ? form.tls : undefined,
          token: form.token,
          clearToken: form.clearToken,
          model: form.model,
          acpTransport: form.kind === 'acp' ? form.acpTransport : undefined,
          acpCommand: form.kind === 'acp' && form.acpTransport === 'stdio' ? form.acpCommand : undefined,
          ...(acpArgs ? { acpArgs } : {}),
          acpRuntimeUser: form.kind === 'acp' && form.acpTransport === 'stdio' ? form.acpRuntimeUser : undefined,
          acpLauncher: form.kind === 'acp' && form.acpTransport === 'stdio' ? form.acpLauncher : undefined,
        });
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
        await apiPost(ctx, '/api/dsh-knot/agent-delete', { id });
        if (historyAgent === id) {
          historySeq.current++;
          setHistoryAgent('');
          setHistoryItems([]);
          setHistoryError(null);
          setHistoryLoading(false);
        }
        if (chatAgent === id) {
          setChatAgent('');
          setChatSessionId('');
          setChatSessionTitle('');
        }
        setDoctorByAgent((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
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

    const copyContinue = (agentId: string, sessionId: string) => {
      const prompt = `Use agent_continue on agent "${agentId}" session "${sessionId}" to continue our previous discussion.`;
      void navigator.clipboard?.writeText(prompt);
      showToast(t('copiedContinue'));
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
    const runningJobs = jobs.filter((j) => j.status === 'running' || j.status === 'queued');
    const sharedCount = state?.mcp.allowSessions.length ?? 0;

    const chatJobs = jobs
      .filter(
        (j) => j.agentId === chatAgent && (!chatSessionId || j.sessionId === chatSessionId || j.id === chatActiveJobId),
      )
      .slice(0, 20)
      .reverse();

    const filteredAgents = agents.filter((a) => {
      if (filter === 'ssh') return (a.transport ?? 'ssh') === 'ssh';
      if (filter === 'direct') return (a.transport ?? 'ssh') !== 'ssh';
      return true;
    });

    const q = historySearch.trim().toLowerCase();
    const filteredHistory = historyItems.filter(
      (item) => !q || item.id.toLowerCase().includes(q) || (item.title ?? '').toLowerCase().includes(q),
    );
    const visibleHistory = q ? filteredHistory : filteredHistory.slice(0, historyLimit);

    return h(
      'div',
      { className: 'dk-root' },
      toast ? h('div', { className: 'dk-toast' }, toast) : null,
      h(
        'div',
        { className: 'dk-wrap' },
        // Top Header
        h(
          'div',
          { className: 'dk-header' },
          h(
            'div',
            { className: 'dk-header-left' },
            h('h1', { className: 'dk-title' }, t('title')),
            h(
              'button',
              { className: 'dk-capsule', disabled: checkingDoctor, onClick: () => void runDoctorAll() },
              '↻ ',
              checkingDoctor ? t('checking') : t('checkAll'),
            ),
            h('button', { className: 'dk-capsule', onClick: () => void refreshState() }, t('refresh')),
            state?.mcp.enabled && state.mcp.address
              ? h(
                  'span',
                  { className: 'dk-capsule dk-capsule-static' },
                  `● MCP ${state.mcp.address.host}:${state.mcp.address.port}`,
                )
              : null,
          ),
          h(
            'div',
            { className: 'dk-header-right' },
            h(
              'div',
              { className: 'dk-seg-track' },
              (['all', 'ssh', 'direct'] as const).map((key) =>
                h(
                  'button',
                  {
                    key,
                    className: `dk-seg ${filter === key ? 'dk-seg-on' : ''}`,
                    onClick: () => setFilter(key),
                  },
                  t(key === 'all' ? 'filterAll' : key === 'ssh' ? 'filterSsh' : 'filterDirect'),
                ),
              ),
            ),
            h(
              'button',
              {
                className: 'dk-capsule dk-mono',
                onClick: () => setLang((cur) => (cur === 'zh-CN' ? 'en' : 'zh-CN')),
              },
              lang === 'zh-CN' ? 'EN' : '中',
            ),
          ),
        ),
        error ? h('div', { className: 'dk-warnbox' }, error) : null,
        // Row 1: 2x2 KPIs + Needs Attention
        h(
          'div',
          { className: 'dk-row1' },
          h(
            'div',
            { className: 'dk-kpis' },
            h(
              'div',
              { className: 'dk-card dk-kpi' },
              h('div', { className: 'dk-muted' }, t('kpiAgents')),
              h(
                'div',
                {
                  className: 'dk-kpi-num',
                  style: { color: agents.length > 0 && verifiedCount === agents.length ? '#15803d' : undefined },
                },
                `${verifiedCount}/${agents.length}`,
              ),
              h('div', { className: 'dk-muted' }, `${agents.length} ${t('kpiAgentsSub')}`),
            ),
            h(
              'div',
              { className: 'dk-card dk-kpi' },
              h('div', { className: 'dk-muted' }, t('kpiPending')),
              h(
                'div',
                { className: 'dk-kpi-num', style: { color: pendingApprovals.length ? '#d97706' : undefined } },
                String(pendingApprovals.length),
              ),
              h('div', { className: 'dk-muted' }, t('kpiPendingSub')),
            ),
            h(
              'div',
              { className: 'dk-card dk-kpi' },
              h('div', { className: 'dk-muted' }, t('kpiRunning')),
              h('div', { className: 'dk-kpi-num' }, String(runningJobs.length)),
              h('div', { className: 'dk-muted' }, t('kpiRunningSub')),
            ),
            h(
              'div',
              { className: 'dk-card dk-kpi' },
              h('div', { className: 'dk-muted' }, t('kpiShared')),
              h('div', { className: 'dk-kpi-num' }, String(sharedCount)),
              h('div', { className: 'dk-muted' }, t('kpiSharedSub')),
            ),
          ),
          h(
            'div',
            { className: 'dk-card' },
            h(
              'div',
              { className: 'dk-card-head' },
              h('span', { className: 'dk-card-title' }, t('attentionTitle')),
              h('span', { className: 'dk-muted dk-mono' }, `v${state?.version ?? '0.1.0'}`),
            ),
            runningJobs.length === 0
              ? h(
                  'div',
                  { className: 'dk-muted', style: { padding: '24px 0', textAlign: 'center' } },
                  t('attentionEmpty'),
                )
              : h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
                  runningJobs.map((job) =>
                    job.pendingApproval
                      ? h(
                          'div',
                          { key: job.id, className: 'dk-warnbox' },
                          h(
                            'div',
                            {
                              style: {
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                                gap: '8px',
                              },
                            },
                            h('strong', null, `${job.agentId} · ${t('wantsApproval')}`),
                            h(
                              'div',
                              { style: { display: 'flex', gap: '6px' } },
                              agents.find((a) => a.id === job.agentId)?.supportsRespond === false
                                ? h('span', { className: 'dk-pill-off' }, t('approveRemotely'))
                                : (job.pendingApproval.choices.length
                                    ? job.pendingApproval.choices
                                    : ['approve', 'deny']
                                  ).map((choice) =>
                                    h(
                                      'button',
                                      {
                                        key: choice,
                                        className: /deny|reject|no/i.test(choice)
                                          ? 'dk-btn dk-btn-danger'
                                          : 'dk-btn dk-btn-primary',
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
                          { key: job.id, className: 'dk-subbox' },
                          h(
                            'div',
                            {
                              style: {
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                                gap: '8px',
                              },
                            },
                            h('span', null, `${job.agentId} · ${t('runningNow')}`),
                            h(
                              'button',
                              { className: 'dk-btn dk-btn-danger', onClick: () => void cancelJob(job.id) },
                              t('stopTask'),
                            ),
                          ),
                          job.text
                            ? h(
                                'div',
                                { className: 'dk-muted dk-mono', style: { marginTop: '6px' } },
                                job.text.slice(-180),
                              )
                            : null,
                        ),
                  ),
                ),
          ),
        ),
        // Row 2: Connected Remote Agents
        h(
          'div',
          { className: 'dk-card' },
          h(
            'div',
            { className: 'dk-card-head' },
            h('span', { className: 'dk-card-title' }, t('agentsHeading')),
            h('button', { className: 'dk-btn dk-btn-primary', onClick: openAddForm }, t('addAgent')),
          ),
          filteredAgents.length === 0
            ? h('div', { className: 'dk-muted', style: { padding: '12px 0' } }, t('agentsEmpty'))
            : h(
                'div',
                { className: 'dk-agents-grid' },
                filteredAgents.map((agent) => {
                  const steps = doctorByAgent[agent.id] ?? agent.connection?.steps;
                  const connStatus = agent.connection?.status ?? 'unverified';
                  const isOpen = Boolean(expandedDoctor[agent.id]);
                  const sshLabel = agent.ssh
                    ? agent.ssh
                    : `${agent.sshUser ? `${agent.sshUser}@` : ''}${agent.sshHost ?? ''}${agent.sshPort ? `:${agent.sshPort}` : ''}`;
                  const endpoint =
                    (agent.transport ?? 'ssh') === 'ssh'
                      ? agent.kind === 'acp' && agent.acpTransport === 'stdio'
                        ? `SSH (${sshLabel}) → stdio${agent.acpRuntimeUser ? ` as ${agent.acpRuntimeUser}` : ''}`
                        : `SSH (${sshLabel}) → :${agent.port ?? ''}`
                      : formatDirectEndpoint(agent);
                  return h(
                    'div',
                    { key: agent.id, className: 'dk-subbox' },
                    h(
                      'div',
                      {
                        style: {
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'flex-start',
                          gap: '8px',
                        },
                      },
                      h(
                        'div',
                        null,
                        h(
                          'div',
                          { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } },
                          h('span', { style: { fontWeight: 600, fontSize: '14px' } }, agent.id),
                          connStatus === 'connected'
                            ? h('span', { className: 'dk-pill-ok' }, t('statusConnected'))
                            : connStatus === 'error'
                              ? h(
                                  'span',
                                  { className: 'dk-pill-err' },
                                  `${t('statusFailed')}${agent.connection?.failedStep ? `: ${agent.connection.failedStep}` : ''}`,
                                )
                              : h('span', { className: 'dk-pill-off' }, t('statusUnverified')),
                          agent.hasToken ? h('span', { className: 'dk-pill-off' }, t('tokenConfigured')) : null,
                        ),
                        h(
                          'div',
                          { className: 'dk-muted dk-mono', style: { marginTop: '2px' } },
                          `${agent.kind} · ${endpoint}`,
                        ),
                      ),
                      h(
                        'div',
                        { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
                        h(
                          'button',
                          { className: 'dk-btn-link', onClick: () => startChatWith(agent.id) },
                          t('chatWithAgent'),
                        ),
                        h(
                          'button',
                          { className: 'dk-btn-link', onClick: () => void loadHistory(agent.id) },
                          t('viewHistory'),
                        ),
                        h('button', { className: 'dk-btn', onClick: () => openEditForm(agent) }, t('editAgent')),
                        h(
                          'button',
                          {
                            className: 'dk-btn dk-btn-danger',
                            onClick: () => void removeAgent(agent.id),
                            onBlur: () => setConfirmDeleteId((cur) => (cur === agent.id ? null : cur)),
                          },
                          confirmDeleteId === agent.id ? t('confirmDeleteAgent') : t('deleteAgent'),
                        ),
                        h(
                          'button',
                          {
                            className: 'dk-btn',
                            disabled: checkingDoctor,
                            onClick: () => void runDoctorAll(agent.id),
                          },
                          t('retest'),
                        ),
                        steps
                          ? h(
                              'button',
                              {
                                className: 'dk-btn',
                                onClick: () => setExpandedDoctor((prev) => ({ ...prev, [agent.id]: !prev[agent.id] })),
                              },
                              isOpen ? t('hide') : t('details'),
                            )
                          : null,
                      ),
                    ),
                    connStatus === 'error' && agent.connection?.error && !isOpen
                      ? h(
                          'div',
                          { className: 'dk-errbox', style: { marginTop: '8px', fontSize: '12px' } },
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
                          {
                            style: {
                              marginTop: '10px',
                              paddingTop: '8px',
                              borderTop: '1px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.08))',
                              display: 'flex',
                              flexDirection: 'column',
                              gap: '6px',
                            },
                          },
                          steps.map((step) =>
                            h(
                              'div',
                              {
                                key: step.name,
                                className: 'dk-mono',
                                style: {
                                  fontSize: '11.5px',
                                  display: 'flex',
                                  flexDirection: 'column',
                                  gap: '2px',
                                },
                              },
                              h(
                                'div',
                                { style: { display: 'flex', justifyContent: 'space-between', gap: '8px' } },
                                h(
                                  'span',
                                  { style: { color: step.ok ? '#15803d' : '#dc2626', fontWeight: 500 } },
                                  `${step.ok ? '✓' : '!'} ${step.name}`,
                                ),
                                h('span', { className: 'dk-muted', style: { wordBreak: 'break-word' } }, step.detail),
                              ),
                              step.hint ? h('div', { className: 'dk-muted' }, `→ ${step.hint}`) : null,
                            ),
                          ),
                        )
                      : null,
                  );
                }),
              ),
        ),
        // Row 2.5: Direct Chat Panel
        h(
          'div',
          { className: 'dk-card' },
          h(
            'div',
            { className: 'dk-card-head' },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
              h('span', { className: 'dk-card-title' }, t('chatHeading')),
              h(
                'select',
                {
                  className: 'dk-input',
                  value: chatAgent,
                  onChange: (e: { target: { value: string } }) => startChatWith(e.target.value),
                },
                h('option', { value: '' }, t('chatSelectAgent')),
                agents.map((a) => h('option', { key: a.id, value: a.id }, a.id)),
              ),
              chatSessionId
                ? h(
                    'span',
                    { className: 'dk-capsule dk-capsule-static' },
                    `${t('chatResuming')}: ${chatSessionTitle || chatSessionId.slice(0, 20)}`,
                  )
                : null,
            ),
            chatSessionId
              ? h(
                  'button',
                  {
                    className: 'dk-btn',
                    onClick: () => startChatWith(chatAgent),
                  },
                  t('chatNewSession'),
                )
              : null,
          ),
          !chatAgent
            ? h('div', { className: 'dk-muted', style: { padding: '12px 0' } }, t('chatSelectAgent'))
            : h(
                'div',
                null,
                chatJobs.length === 0
                  ? h('div', { className: 'dk-muted', style: { padding: '10px 0 12px' } }, t('chatEmpty'))
                  : h(
                      'div',
                      { className: 'dk-chat-log' },
                      chatJobs.map((job) =>
                        h(
                          'div',
                          { key: job.id, style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
                          job.prompt ? h('div', { className: 'dk-chat-user' }, job.prompt) : null,
                          h(
                            'div',
                            { className: 'dk-chat-bot' },
                            job.text ? h('div', null, job.text) : null,
                            job.status === 'running' || job.status === 'queued'
                              ? h(
                                  'div',
                                  {
                                    style: {
                                      display: 'flex',
                                      alignItems: 'center',
                                      justifyContent: 'space-between',
                                      gap: '8px',
                                      marginTop: job.text ? '6px' : 0,
                                    },
                                  },
                                  h('span', { className: 'dk-muted' }, `${job.agentId} · ${t('runningNow')}…`),
                                  h(
                                    'button',
                                    { className: 'dk-btn dk-btn-danger', onClick: () => void cancelJob(job.id) },
                                    t('stopTask'),
                                  ),
                                )
                              : null,
                            job.status === 'failed'
                              ? h(
                                  'div',
                                  {
                                    className: 'dk-mono',
                                    style: { color: '#dc2626', marginTop: job.text ? '6px' : 0 },
                                  },
                                  `${t('chatFailed')}: ${job.error ?? 'Unknown error'}`,
                                )
                              : null,
                            job.status === 'cancelled'
                              ? h(
                                  'div',
                                  { className: 'dk-muted', style: { marginTop: job.text ? '6px' : 0 } },
                                  t('chatCancelled'),
                                )
                              : null,
                          ),
                        ),
                      ),
                    ),
                chatError ? h('div', { className: 'dk-errbox', style: { marginBottom: '8px' } }, chatError) : null,
                h(
                  'div',
                  { style: { display: 'flex', gap: '8px', alignItems: 'flex-end' } },
                  h('textarea', {
                    className: 'dk-textarea',
                    placeholder: t('chatPlaceholder'),
                    value: chatInput,
                    disabled: chatSending,
                    onInput: (e: { target: { value: string } }) => setChatInput(e.target.value),
                    onKeyDown: (e: { key: string; shiftKey: boolean; preventDefault: () => void }) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        void sendChatMessage();
                      }
                    },
                  }),
                  h(
                    'button',
                    {
                      className: 'dk-btn dk-btn-primary',
                      style: { padding: '8px 16px', flexShrink: 0 },
                      disabled: chatSending || !chatInput.trim(),
                      onClick: () => void sendChatMessage(),
                    },
                    chatSending ? t('chatSending') : t('chatSend'),
                  ),
                ),
              ),
        ),
        // Row 3: Remote History Browser + Local Shared Chats
        h(
          'div',
          { className: 'dk-row3' },
          h(
            'div',
            { className: 'dk-card' },
            h(
              'div',
              { className: 'dk-card-head' },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
                h('span', { className: 'dk-card-title' }, t('historyHeading')),
                h(
                  'select',
                  {
                    className: 'dk-input',
                    value: historyAgent,
                    onChange: (e: { target: { value: string } }) => void loadHistory(e.target.value),
                  },
                  h('option', { value: '' }, t('selectAgentPrompt')),
                  agents.map((a) => h('option', { key: a.id, value: a.id }, a.id)),
                ),
              ),
              h('input', {
                className: 'dk-input',
                type: 'search',
                value: historySearch,
                placeholder: t('searchPlaceholder'),
                onInput: (e: { target: { value: string } }) => setHistorySearch(e.target.value),
              }),
            ),
            !historyAgent
              ? h(
                  'div',
                  { className: 'dk-muted', style: { padding: '20px 0', textAlign: 'center' } },
                  t('selectAgentPrompt'),
                )
              : historyLoading
                ? h(
                    'div',
                    { className: 'dk-muted', style: { padding: '20px 0', textAlign: 'center' } },
                    t('loadingHistory'),
                  )
                : historyError
                  ? h(
                      'div',
                      { className: 'dk-errbox' },
                      h('div', { style: { fontWeight: 600 } }, t('historyErrorTitle')),
                      h(
                        'div',
                        { className: 'dk-mono', style: { fontSize: '12px', wordBreak: 'break-word' } },
                        historyError,
                      ),
                      h(
                        'div',
                        null,
                        h(
                          'button',
                          { className: 'dk-btn dk-btn-primary', onClick: () => void loadHistory(historyAgent) },
                          t('retry'),
                        ),
                      ),
                    )
                  : visibleHistory.length === 0
                    ? h(
                        'div',
                        { className: 'dk-muted', style: { padding: '20px 0', textAlign: 'center' } },
                        t('noHistory'),
                      )
                    : h(
                        'div',
                        null,
                        visibleHistory.map((item) =>
                          h(
                            'div',
                            { key: item.id, className: 'dk-list-row' },
                            h(
                              'div',
                              { style: { minWidth: 0 } },
                              h('div', { style: { fontWeight: 500 } }, item.title ?? item.id),
                              h('div', { className: 'dk-muted dk-mono' }, item.id),
                            ),
                            h(
                              'div',
                              { style: { display: 'flex', gap: '8px', flexShrink: 0 } },
                              h(
                                'button',
                                {
                                  className: 'dk-btn dk-btn-primary',
                                  onClick: () => startChatWith(historyAgent, item.id, item.title ?? ''),
                                },
                                t('resumeInPanel'),
                              ),
                              h(
                                'button',
                                { className: 'dk-btn-link', onClick: () => copyContinue(historyAgent, item.id) },
                                t('continuePrompt'),
                              ),
                            ),
                          ),
                        ),
                        !q && filteredHistory.length > visibleHistory.length
                          ? h(
                              'button',
                              {
                                className: 'dk-btn-link',
                                style: { display: 'block', margin: '10px auto 0' },
                                onClick: () => setHistoryLimit((n) => n + 6),
                              },
                              `${t('loadMore')} (${filteredHistory.length - visibleHistory.length})`,
                            )
                          : null,
                      ),
          ),
          h(
            'div',
            { className: 'dk-card' },
            h(
              'div',
              { className: 'dk-card-head' },
              h(
                'div',
                null,
                h('div', { className: 'dk-card-title' }, t('shareHeading')),
                h('div', { className: 'dk-muted' }, t('shareSub')),
              ),
              state?.mcp.enabled ? h('button', { className: 'dk-capsule', onClick: copyYaml }, t('copyYaml')) : null,
            ),
            !state?.mcp.enabled
              ? h('div', { className: 'dk-muted', style: { padding: '16px 0' } }, t('mcpDisabled'))
              : state.mcp.localSessions.length === 0
                ? h('div', { className: 'dk-muted', style: { padding: '16px 0' } }, t('noLocalSessions'))
                : h(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
                    state.mcp.localSessions.map((item) =>
                      h(
                        'div',
                        {
                          key: item.sessionId,
                          className: 'dk-subbox',
                          style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' },
                        },
                        h(
                          'div',
                          { style: { minWidth: 0 } },
                          h('div', { style: { fontWeight: 500 } }, item.title ?? item.sessionId),
                          h('div', { className: 'dk-muted dk-mono' }, item.sessionId),
                        ),
                        h(
                          'button',
                          {
                            className: item.shared ? 'dk-pill-ok' : 'dk-pill-off',
                            style: { cursor: 'pointer' },
                            onClick: () => void toggleShare(item.sessionId, !item.shared),
                          },
                          item.shared ? t('sharedOn') : t('sharedOff'),
                        ),
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
                  onClick: (e: { stopPropagation?: () => void }) => e.stopPropagation?.(),
                },
                h(
                  'div',
                  { className: 'dk-card-head', style: { marginBottom: 0 } },
                  h('span', { className: 'dk-card-title' }, t(form.editing ? 'modalEditTitle' : 'modalAddTitle')),
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
                            cur ? { ...cur, transport: e.target.value as AgentFormState['transport'] } : null,
                          ),
                      },
                      h('option', { value: 'direct' }, t('transportDirectOpt')),
                      h('option', { value: 'ssh' }, t('transportSshOpt')),
                      h('option', { value: 'local' }, t('transportLocalOpt')),
                    ),
                  ),
                  !(form.kind === 'acp' && form.acpTransport === 'stdio')
                    ? h(
                        'label',
                        { className: 'dk-field' },
                        h('span', null, t('fieldPort')),
                        h('input', {
                          className: 'dk-input dk-mono',
                          type: 'number',
                          placeholder: defaultPortForKind(
                            form.kind,
                            form.transport === 'direct' && (form.tls || /^https:\/\//i.test(form.endpoint.trim())),
                          ),
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
                      { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
                      h('div', { className: 'dk-muted', style: { fontSize: '11.5px' } }, t('directSetupTip')),
                      h(
                        'label',
                        { className: 'dk-field' },
                        h('span', null, t('fieldEndpoint')),
                        h('input', {
                          className: 'dk-input dk-mono',
                          placeholder: 'https://my-vm.tailnet.ts.net',
                          value: form.endpoint,
                          onInput: (e: { target: { value: string } }) => {
                            const val = e.target.value;
                            setForm((cur) =>
                              cur
                                ? {
                                    ...cur,
                                    endpoint: val,
                                    ...(val.trim().startsWith('https://') ? { tls: true } : {}),
                                    ...(val.trim().startsWith('http://') ? { tls: false } : {}),
                                  }
                                : null,
                            );
                          },
                        }),
                      ),
                      !/^(https?|wss?):\/\//i.test(form.endpoint.trim())
                        ? h(
                            'label',
                            { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' } },
                            h('input', {
                              type: 'checkbox',
                              checked: form.tls,
                              onChange: (e: { target: { checked: boolean } }) =>
                                setForm((cur) => (cur ? { ...cur, tls: Boolean(e.target.checked) } : null)),
                            }),
                            h('span', null, t('fieldTls')),
                          )
                        : null,
                    )
                  : form.transport === 'local'
                    ? h(
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
                      )
                    : h(
                        'div',
                        { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
                        h(
                          'div',
                          { className: 'dk-field-row' },
                          h(
                            'label',
                            { className: 'dk-field' },
                            h('span', null, t('fieldSshHost')),
                            h('input', {
                              className: 'dk-input dk-mono',
                              placeholder: 'ec2-1-2-3-4.compute.amazonaws.com',
                              value: form.sshHost,
                              onInput: (e: { target: { value: string } }) =>
                                setForm((cur) => (cur ? { ...cur, sshHost: e.target.value } : null)),
                            }),
                          ),
                          h(
                            'label',
                            { className: 'dk-field' },
                            h('span', null, t('fieldSshPort')),
                            h('input', {
                              className: 'dk-input dk-mono',
                              type: 'number',
                              placeholder: '22',
                              value: form.sshPort,
                              onInput: (e: { target: { value: string } }) =>
                                setForm((cur) => (cur ? { ...cur, sshPort: e.target.value } : null)),
                            }),
                          ),
                        ),
                        h(
                          'div',
                          { className: 'dk-field-row' },
                          h(
                            'label',
                            { className: 'dk-field' },
                            h('span', null, t('fieldSshUser')),
                            h('input', {
                              className: 'dk-input dk-mono',
                              placeholder: 'ubuntu',
                              value: form.sshUser,
                              onInput: (e: { target: { value: string } }) =>
                                setForm((cur) => (cur ? { ...cur, sshUser: e.target.value } : null)),
                            }),
                          ),
                          h(
                            'label',
                            { className: 'dk-field' },
                            h('span', null, t('fieldSsh')),
                            h('input', {
                              className: 'dk-input dk-mono',
                              placeholder: 'optional alias (e.g. aws-hermes)',
                              value: form.ssh,
                              onInput: (e: { target: { value: string } }) =>
                                setForm((cur) => (cur ? { ...cur, ssh: e.target.value } : null)),
                            }),
                          ),
                        ),
                        h(
                          'div',
                          { className: 'dk-field' },
                          h('span', null, t('fieldSshKey')),
                          h(
                            'div',
                            { style: { display: 'flex', gap: '6px' } },
                            h('input', {
                              className: 'dk-input dk-mono',
                              style: { flex: 1, minWidth: 0 },
                              placeholder: '~/.ssh/aws-hermes.pem',
                              value: form.sshIdentityFile,
                              onInput: (e: { target: { value: string } }) =>
                                setForm((cur) => (cur ? { ...cur, sshIdentityFile: e.target.value } : null)),
                            }),
                            h(
                              'label',
                              { className: 'dk-btn', style: { display: 'inline-flex', alignItems: 'center' } },
                              t('fieldSshKeyBrowse'),
                              h('input', {
                                type: 'file',
                                accept: '.pem,.key,*',
                                style: { display: 'none' },
                                onChange: (e: { target: { files?: ArrayLike<{ name: string; path?: string }> } }) => {
                                  const file = e.target.files?.[0];
                                  if (!file) return;
                                  const pickedPath = file.path || `~/.ssh/${file.name}`;
                                  setForm((cur) => (cur ? { ...cur, sshIdentityFile: pickedPath } : null));
                                },
                              }),
                            ),
                          ),
                          localKeys.length > 0
                            ? h(
                                'select',
                                {
                                  className: 'dk-input dk-mono',
                                  value: localKeys.some((k) => k.path === form.sshIdentityFile)
                                    ? form.sshIdentityFile
                                    : '',
                                  onChange: (e: { target: { value: string } }) => {
                                    if (e.target.value) {
                                      setForm((cur) => (cur ? { ...cur, sshIdentityFile: e.target.value } : null));
                                    }
                                  },
                                },
                                h('option', { value: '' }, t('fieldSshKeyPick')),
                                localKeys.map((k) =>
                                  h(
                                    'option',
                                    { key: k.path, value: k.path },
                                    k.permissionsWarning ? `${k.path} (${k.permissionsWarning})` : k.path,
                                  ),
                                ),
                              )
                            : null,
                        ),
                      ),
                form.kind === 'acp'
                  ? h(
                      'div',
                      { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
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
                            'div',
                            { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
                            h(
                              'div',
                              { className: 'dk-field-row' },
                              h(
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
                              ),
                              h(
                                'label',
                                { className: 'dk-field' },
                                h('span', null, t('fieldAcpRuntimeUser')),
                                h('input', {
                                  className: 'dk-input dk-mono',
                                  placeholder: 'root (optional)',
                                  value: form.acpRuntimeUser,
                                  onInput: (e: { target: { value: string } }) =>
                                    setForm((cur) => (cur ? { ...cur, acpRuntimeUser: e.target.value } : null)),
                                }),
                              ),
                            ),
                            h('div', { className: 'dk-muted', style: { fontSize: '11.5px' } }, t('fieldAcpRuntimeTip')),
                            h(
                              'label',
                              { className: 'dk-field' },
                              h('span', null, t('fieldAcpLauncher')),
                              h('input', {
                                className: 'dk-input dk-mono',
                                placeholder: 'sudo -n /usr/local/bin/hermes-acp',
                                value: form.acpLauncher,
                                onInput: (e: { target: { value: string } }) =>
                                  setForm((cur) => (cur ? { ...cur, acpLauncher: e.target.value } : null)),
                              }),
                            ),
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
                      { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' } },
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
                  { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '4px' } },
                  h('button', { className: 'dk-btn', disabled: saving, onClick: () => setForm(null) }, t('cancelBtn')),
                  h(
                    'button',
                    {
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
  const Dashboard = makeDashboard(React, ctx);
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
