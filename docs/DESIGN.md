# DSH Knot design

The real model-backed E2E matrix covers native and ACP v1 paths across 18 network, target, and protocol combinations.

## Goals

1. Let a dsh session run tasks on remote Hermes, OpenClaw, and dsh agents, continue those sessions, stream results, answer approvals where supported, and cancel work.
2. Let remote agents read and watch explicitly shared local dsh sessions through MCP.
3. Avoid third-party relays and avoid installing adapters on every remote harness.
4. Keep protocol details behind adapters and network details behind transports.

The current release intentionally does not write to local dsh sessions through MCP, mirror complete sessions, provide a cloud relay, or perform WebRTC NAT traversal.

## Layers

```text
┌──────────────────────── local dsh ────────────────────────┐
│ dsh-knot                                                  │
│  adapters/    ACP provider + native compatibility drivers │
│  transports/  direct (default), local                   │
│  tools/       agent_list / agent_ask / agent_continue / … │
│  manager      jobs, output, cancellation, notifications   │
│  mcp/         read-only session export                    │
│  policy/      allow-list, bearer authentication, redaction│
└────────────┬────────────────────────────────▲─────────────┘
             │ forward: dsh → Agent            │ reverse: Agent → dsh MCP
     ┌───────▼────────┐                ┌───────┴─────────┐
     │ Hermes API     │                │ OpenClaw Gateway│
     │ Server         │                │ WebSocket       │
     └────────────────┘                └─────────────────┘
```

Adapters own message semantics. Transports own connectivity. Neither layer contains the other layer's configuration or protocol assumptions.

## Protocol adapters

### Shared adapter contract

```ts
interface AgentAdapter {
  id: string;
  kind: 'hermes' | 'openclaw' | 'dsh' | 'acp';
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

### ACP v1 provider and bridge

The `acp` kind is the single provider for ACP-compatible endpoints. The official TypeScript SDK negotiates stable protocol v1 and carries JSON-RPC messages over WebSocket or standard NDJSON stdio for local subprocesses. Session aliases are mapped to the actual ACP `sessionId`, so subsequent prompts continue the same conversation. The client uses the SDK's `ActiveSession` plus one event queue to preserve update/stop ordering without losing permission events to abandoned race waiters.

The optional `dsh-knot-acp` bridge exposes `initialize`, `session/new`, `session/list`, `session/prompt`, `session/cancel`, `session/update`, and `session/request_permission` over WebSocket or `DSH_KNOT_ACP_STDIO=1` stdio mode. Each bridge connection constructs a native adapter for Hermes, OpenClaw, or remote DSH and translates only that adapter's normalized events. A native ACP endpoint bypasses the bridge entirely. Non-loopback bridge listeners require `DSH_KNOT_ACP_TOKEN`; native gateway credentials and ACP bearer tokens remain separate.

For Hermes, dsh-knot peers negotiate interim retraction so they can stream text immediately and correct it when a commentary marker arrives. Other ACP clients receive text at classification boundaries to keep commentary out of the answer channel. If unclassified text exceeds 2,000,000 characters, the bridge discards that buffer, attempts to stop the run, and reports the limit error. If the stop is unconfirmed, the same connection must retry `session/cancel` successfully before sending another prompt to that session.

The Hermes WebSocket bridge also negotiates stop recovery. It associates an opaque prompt ID with the exact native run ID in a bounded registry shared across its connections. On retry after the original request is gone, the bridge acknowledges a stop only after that run reaches a terminal state. Older peers, missing runs, and bridge restarts can leave the stop unconfirmed. Once the local prompt and stop request have ended, an explicit local release can unlock and reclaim any exclusive job (ACP or native) while preserving the unconfirmed remote status.

ACP v2, A2A, and additional UI transports are intentionally outside the current scope.

### Hermes

The adapter uses the native API Server:

- `POST /v1/runs` with `{ input, session_id, model? }` and an `Idempotency-Key`.
- `GET /v1/runs/{id}/events` for Server-Sent Events.
- `GET /v1/runs/{id}` as a terminal-status fallback.
- `POST /v1/runs/{id}/approval` for approval responses.
- `POST /v1/runs/{id}/stop` for cancellation.
- Authenticated `GET /v1/capabilities` and `GET /health` for readiness.
- `GET /api/sessions?source=api_server` for resumable history.
- `GET /api/sessions/{id}/messages?inline_images=false` for the recent text transcript in Remote Agents.

Authentication uses `Authorization: Bearer …`, read from `token` or `tokenEnv` (default `HERMES_API_KEY`). The token is not logged.

### OpenClaw

The adapter opens a Gateway WebSocket with subprotocol `json`, negotiates protocol version 4, waits for `connect.challenge`, and sends a `connect` request containing:

- the `cli` client descriptor with `cli` mode, operator role, and the actual host platform,
- operator role and scopes,
- the gateway token,
- a persistent Ed25519 device identity and a signature over the v2 claim,
- the server nonce and the challenge's `ts` as `device.signedAt`.

Device keys live under `$DSH_HOME/knot/devices` with mode `0600`. The device ID is the SHA-256 hash of the public key's raw x coordinate. The signing format is isolated in `openclaw-identity.ts` so upstream protocol changes have one review point.

After pairing, the adapter uses `health`, `sessions.list`, `agent`, repeated `agent.wait` calls while a run is pending, and `sessions.abort` with the session `key`. RPC envelopes use `{ type: 'req', id, method, params }`, responses use `type: 'res'`, and streamed agent updates use `type: 'event'`. Reverse requests receive an explicit unsupported-method error instead of hanging.

OpenClaw protocol behavior still needs validation against every target deployment version. `knot_doctor` is the first compatibility check.

### Remote DSH

The DSH adapter uses the native Web/API connection rather than the plugin's read-only MCP listener. `GET /connect?token=...&interactions=none` exchanges the launch token for an API Cookie. Calls then use the Connection envelope `{ type: 'client-request', rpcId, method: 'session/<method>', payload: { args } }` and check the nested `{ ok: true, value }` result.

Session work uses `session/create`, optional `session/selectModel`, `session/prompt`, repeated `session/wait` calls while the Session is active, `session/list` for discovery, and `session/cancel` for cancellation. RPC arguments use the Remote method's parameter envelope (`request`, or `_request` for `session/list`). The adapter remembers requested-to-actual Session ID mappings so continuations prompt the existing Session instead of creating a new one. Assistant text is read only from durable `assistant/message.data.message.content` records; an empty wait output triggers a durable event read so model failures are reported instead of becoming empty successful jobs. The launch token and API Cookie are never logged.

Remote deployments should keep the native listener on loopback behind a private proxy or configure a concrete bind IP and `--trusted-host` for a private network. The CI container uses a test-only Host-rewrite bridge to preserve that trust boundary.

## Transports

### Direct (default)

`direct` uses an explicit gateway URL or a hostname and port. With Tailscale Serve, keep the gateway on loopback and use its HTTPS endpoint. See the [setup guide](../README.md#quick-start).

### Local

`local` uses `127.0.0.1` as the default host and also supports ACP stdio subprocesses.

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

Implemented checks cover configuration, redaction, Hermes API/SSE normalization, OpenClaw pairing over a real WebSocket, device identity persistence, native DSH Session RPC, ACP prompt/continuation/tool/permission/cancel flows over the official WebSocket transport and a real NDJSON stdio subprocess, job lifecycle, HTTP transport, and MCP authorization/read/watch behavior. The transport matrix requires real model-backed initial tasks and same-session continuations for Hermes, OpenClaw, and remote DSH over Local, Tailscale, and Headscale.

Remaining deployment milestones:

1. Add persistent reconnect supervision and richer approval routing where each gateway supports it.
2. Add a small sidebar status panel and Tailscale node discovery.
3. Consider explicit write-enabled MCP sessions only after the read-only security boundary has been exercised.

## Repository references

- [Agent Client Protocol](https://agentclientprotocol.com)
- [Official ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk)
- [Hermes programmatic integration](https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration)
- [ODSH-Bridge OpenClaw pairing reference](https://github.com/Mikoribbit/odsh-bridge)
- [OpenClaw Gateway handshake](https://docs.openclaw.ai/gateway/protocol/handshake)
- [Transport integration test infrastructure](E2E.md)
