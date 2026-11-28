# DSH Knot design

## Goals

1. Let a dsh session run and continue tasks on Paseo agents and on remote dsh.
2. Stream output, surface remote approvals, and cancel the owned turn.
3. Let remote agents read and watch explicitly shared local dsh sessions through a separate MCP listener.
4. Keep private connectivity and protocol handling behind adapters.

## Layers

```text
dsh tools / Remote Agents → AgentManager → Paseo SDK → Paseo daemon → registered provider
                                        → DshAdapter        → dsh web HTTP RPC
remote agent              → read-only MCP listener           → shared local dsh sessions
```

Adapters own message semantics. Transports own connectivity. Neither layer contains the other layer's configuration or protocol assumptions.

## Protocol adapters

### Shared adapter contract

```ts
interface AgentAdapter {
  id: string;
  kind: 'dsh' | 'paseo';
  health(signal?): Promise<Record<string, unknown>>;
  listSessions(signal?): Promise<AgentSession[]>;
  getSessionMessages?(sessionId: string, signal?): Promise<AgentTranscriptMessage[]>;
  prompt(sessionId: string | undefined, text: string, signal?, options?: AgentPromptOptions): AsyncIterable<AgentEvent>;
  cancel(sessionId: string, signal?): Promise<void>;
  respond?(sessionId: string, requestId: string, choice: string, signal?): Promise<void>;
  close(): Promise<void>;
}
```

`AgentEvent` normalizes reply text, streamed thought text, tool activity, approvals, final results, and errors. The Remote Agents chat displays bounded thought text and, when a gateway reports tool input, a bounded, redacted preview. Model tools receive reply text, tool names, and status.

### Paseo provider

Knot connects directly to an authenticated Paseo daemon with `@getpaseo/client`. The provider list comes from the daemon's live catalog. Paseo owns provider configuration, executable launch, session persistence, and harness-specific behavior. Knot creates labeled agents and treats their Paseo agent IDs as session IDs. Only active, non-archived agents with the connection's label and provider appear in the session list.

Knot subscribes to live timeline events before sending a prompt. It matches the user-message ID to the submitted prompt, follows the accepted turn's output, and treats its terminal event as confirmation. Permission responses use the daemon's acknowledgements. For stop, Knot checks the live agent and original turn ID before calling the daemon's cancel operation. Disconnect before terminal confirmation leaves the remote stop unconfirmed. Use Knot to drive turns on agents created by Knot. Paseo 0.18.1 exposes an agent-level stop and accepts new messages by agent ID, so a concurrent send from another Paseo client can race Knot's turn check.

The pinned SDK's package root provides the catalog, agent handles, and timeline subscription. The adapter uses the same SDK's low-level client for create with a daemon-selected default model, acknowledgement of permission responses, and cancellation.

### Remote DSH

The DSH adapter uses the native Web/API connection rather than the plugin's read-only MCP listener. `GET /connect?token=...&interactions=none` exchanges the launch token for an API Cookie. Calls then use the Connection envelope `{ type: 'client-request', rpcId, method: 'session/<method>', payload: { args } }` and check the nested `{ ok: true, value }` result.

Session work uses `session/create`, optional `session/selectModel`, `session/prompt`, repeated `session/wait` calls while the Session is active, `session/list` for discovery, and `session/cancel` for cancellation. RPC arguments use the Remote method's parameter envelope (`request`, or `_request` for `session/list`). The adapter remembers requested-to-actual Session ID mappings so continuations prompt the existing Session instead of creating a new one. Assistant text is read only from durable `assistant/message.data.message.content` records; an empty wait output triggers a durable event read so model failures are reported instead of becoming empty successful jobs. The launch token and API Cookie are never logged.

Remote deployments should keep the native listener on loopback behind a private proxy or configure a concrete bind IP and `--trusted-host` for a private network. The CI container uses a test-only Host-rewrite bridge to preserve that trust boundary.

## Transports

### Direct (default)

`direct` uses an explicit gateway URL or a hostname and port. With Tailscale Serve, keep the gateway on loopback and use its HTTPS endpoint. See the [setup guide](../README.md#quick-start).

### Local

`local` uses `127.0.0.1` as the default host for both Paseo and Remote DSH.

Both transports check the endpoint before sending gateway credentials. Outside loopback, HTTPS or WSS is required unless `encryptedOverlay: true` declares a verified, authenticated encrypted private route for that endpoint. Existing blocked entries remain editable. The [transport guide](../README.md#transports) covers setup and migration.

## Jobs and model tools

`agent_ask` and `agent_continue` create a local job and return its ID immediately unless `wait: true` is supplied. The manager:

- generates a remote session ID when needed,
- accumulates streamed output with a bounded in-memory limit,
- records pending approvals,
- forwards cancellation to the adapter,
- enforces the configured timeout,
- optionally calls `Agent.followup()` on completion.

The originating Agent's `followup` receives a marked `source.kind: knot` message. Missing follow-up support does not fail the remote job.

Before continuing a history-capable session, the manager gives the transcript read up to one second. The browser uses the job's own snapshot to merge a live turn with history. If the prior tail or matching next turn is uncertain, it keeps the observed turn visible separately. When an exclusive Remote Agents chat session already has a running turn, the user can opt in to queue up to 20 follow-up messages per session, with a 64 KiB UTF-8 limit per queued message. Queued turns start sequentially after the previous turn completes and are cancelled automatically if a preceding turn fails or is stopped. Removing a queued turn only succeeds before dispatch.

## Reverse MCP endpoint

The MCP server is a separate HTTP listener, not a route on the dsh Web server. Exposing the dsh Web server would expose its browser UI, plugin routes, and cookie-authenticated API.

The endpoint supports JSON-RPC `initialize`, `ping`, `tools/list`, and `tools/call`, including notification handling and batch requests. It implements Streamable HTTP POST semantics without opening a public SSE endpoint.

Tools:

| Tool                | Behavior                                                                | Permission |
| ------------------- | ----------------------------------------------------------------------- | ---------- |
| `dsh_sessions_list` | List only allow-listed dsh sessions.                                    | read       |
| `dsh_session_read`  | Read a message-aligned history page through `sessionController.events`. | read       |
| `dsh_session_watch` | Follow a session and return new frames plus a cursor.                   | read       |

Authentication uses a bearer token from `token` or `tokenEnv` (default `DSH_KNOT_TOKEN`). Startup fails closed if MCP is enabled without a token. `allowSessions` defaults to an empty set.

### Reverse networking

With Tailscale, bind MCP to the local Tailscale address and use MagicDNS. The listener refuses wildcard binds.

The current release has no `dsh_session_post` tool. Adding write access later requires a separate write token, explicit per-session write permission, origin markers, and loop prevention.

## Security

- Deny session access by default.
- Keep gateways and MCP on loopback or a trusted tailnet interface.
- Redact common bearer tokens, API keys, JWTs, cookies, and private keys recursively before returning MCP content.
- Do not log remote tokens, device private keys, or complete remote configuration.
- Answer remote approvals through the user; never automatically approve by default.
- Reuse persistent gateways instead of launching new agent services on every reconnect.
- Bound request bodies, response bodies, watch payloads, and retained job output.

## Validation and milestones

Tests exercise provider discovery and configuration in the panel, job lifecycle, Remote DSH RPC, and MCP access. The [model-backed matrix](E2E.md) uses a real Paseo daemon for Hermes and OpenClaw.

Remaining deployment milestones:

1. Add persistent reconnect supervision and richer approval routing where each gateway supports it.
2. Add a small sidebar status panel and Tailscale node discovery.
3. Consider explicit write-enabled MCP sessions only after the read-only security boundary has been exercised.

## Repository references

- [Paseo TypeScript SDK](https://github.com/getpaseo/paseo/blob/v0.18.1/public-docs/sdk/index.md)
- [Hermes ACP](https://hermes-agent.nousresearch.com/docs/user-guide/features/acp)
- [OpenClaw ACP](https://docs.openclaw.ai/cli/acp)
- [Transport integration test infrastructure](E2E.md)
