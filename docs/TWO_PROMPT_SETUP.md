# Connect a Remote Agent with Two Prompts

Connect a remote or same-host agent to DeepSeek Harness (`dsh`) without manually editing configuration files or walking through a checklist. You only need to:

1. Pick your private network option.
2. Copy **Prompt 1** to the agent running on the target host and wait for its handoff block.
3. Copy **Prompt 2** — with that handoff block pasted at the bottom — to your local `dsh` agent.

Both agents inspect the live environment, reuse existing services and private networks, run routine installation and setup themselves, and only pause when a human-only step is genuinely required (interactive login, OS permission approval, OpenClaw device pairing, or securely entering a secret).

> **Security rule:** Never paste plaintext tokens, API keys, cookies, private keys, or tokenized URLs (such as `dsh web`'s `/connect?token=...`) into chat handoffs. The handoff block carries only a **safe credential reference** (where the secret lives or which key name to use).

---

## Supported Harnesses & Network Paths

Before starting, check which interface `dsh-knot` reuses for each harness:

| Harness                       | `dsh-knot` Kind | Native / ACP Interface Reused                                                                     | Default Loopback Port | Auth & Pairing                         |
| ----------------------------- | --------------- | ------------------------------------------------------------------------------------------------- | --------------------- | -------------------------------------- |
| **Hermes**                    | `hermes`        | Hermes API Server (`/v1/runs`, SSE, `/v1/capabilities`, `/api/sessions`)                          | `8642`                | `API_SERVER_KEY` (Bearer)              |
| **OpenClaw**                  | `openclaw`      | OpenClaw Gateway WebSocket v4 (`gateway.auth.mode: token`)                                        | `18789`               | Gateway token + Ed25519 device pairing |
| **Remote `dsh`**              | `dsh`           | Native `dsh web` API (`/connect` cookie exchange + `/api/session/*` RPC)                          | `18790`               | `dsh web` launch token                 |
| **ACP v1 (WebSocket)**        | `acp`           | Authenticated ACP v1 WebSocket endpoint (`ws://` or `wss://`, default path `/acp`)                | `18792`               | `DSH_KNOT_ACP_TOKEN` (Bearer)          |
| **ACP v1 (stdio, same host)** | `acp`           | Local NDJSON stdio subprocess (`transport: local`, `acpTransport: stdio`), e.g. `claude-code-acp` | N/A                   | Local process (no network token)       |

> **Important note on Claude Code:**
> - **Same host as `dsh`**: Supported directly via `kind: acp`, `transport: local`, `acpTransport: stdio` (for example `acpCommand: /usr/local/bin/claude-code-acp`).
> - **Remote host**: Requires a compatible, Bearer-authenticated **ACP v1 WebSocket bridge** exposing `/acp` over WebSocket (`@agentclientprotocol/sdk` ACP v1). Note that `dsh-knot`'s bundled `dsh-knot-acp` CLI currently wraps native `hermes`, `openclaw`, and `dsh` gateways (`DSH_KNOT_NATIVE_KIND=hermes|openclaw|dsh`) — it does **not** wrap generic stdio ACP binaries like `claude-code-acp`. If no compatible authenticated ACP v1 WebSocket bridge exists on the remote host, Prompt 1 instructs the server agent to stop and report that exact gap instead of improvising an insecure workaround.

### Network Options (Priority Order)

Reuse an existing private network whenever one is already available. Do **not** introduce SSH tunnels or expose agent gateways on public internet interfaces.

- **`auto` (Recommended)**: Reuse an existing Headscale, Tailscale, WireGuard, or trusted private LAN path; if none exists, install Tailscale and configure Tailscale Serve.
- **`tailscale`**: Install Tailscale for the host OS if missing, join your specified tailnet, keep the gateway on loopback (`127.0.0.1`), and expose it via Tailscale Serve HTTPS/WSS.
- **`headscale`**: Reuse the host's existing Headscale-enrolled Tailscale client and private tailnet address without overwriting its control server.
- **`wireguard`**: Reuse the host's existing WireGuard interface and bind the gateway (or a local private reverse proxy) to the WireGuard IP only.
- **`lan`**: Reuse an existing trusted private LAN IP. Use HTTPS or WSS when sending gateway credentials over the LAN.
- **`same-host`**: Loopback (`127.0.0.1`) or local ACP stdio on the same machine as `dsh`.

---

## Step 1 — Prompt for the Server-Side Agent

Fill in **Network choice** (and **Target tailnet** if you choose `tailscale`, plus an optional **Preferred agent ID**), then send this prompt verbatim to the agent running on the target host:

````text
You are preparing this machine so my local DeepSeek Harness (dsh) can connect to it using dsh-knot (https://github.com/Weaxs/dsh-knot).

Preferences:
- Network choice: <auto | tailscale | headscale | wireguard | lan | same-host>
- Target tailnet (only if using Tailscale): <your-tailnet-name-or-leave-blank>
- Preferred agent ID (optional): <e.g. prod-hermes or leave-blank>

Operating rules:
1. Execute routine inspection, installation, service restarts, and local health checks yourself. Do NOT hand me a manual setup checklist.
2. Only stop and ask me to intervene for steps that truly require a human: interactive login/SSO URLs, OS/system permission prompts, device pairing approval, or creating/providing a secret you cannot safely generate.
3. Never introduce SSH tunnels, cloud relays, or public-internet port exposure (never bind unauthenticated gateways to public interfaces).
4. Never print plaintext tokens, API keys, cookies, private keys, or tokenized URLs (such as `/connect?token=...`) in your final handoff output.

Task steps:
1. Discover what is running on this host:
   - Identify the active agent harness (Hermes, OpenClaw, remote dsh, or an ACP v1 agent such as Claude Code), the exact OS service account / user, active profile, supervisor (`systemd`, `launchd`, Docker, tmux, etc.), and config file paths.
   - Prefer reusing an already-running, supported native or ACP interface rather than installing a second stack.

2. Verify or prepare the harness interface (by detected kind):
   - **Hermes (`kind: hermes`)**:
     - Reuse the Hermes API Server in the service account's active profile `.env` (default `~/.hermes/.env`).
     - Ensure `API_SERVER_ENABLED=true`, `API_SERVER_HOST=127.0.0.1` (or the concrete private interface IP when not using a local proxy), `API_SERVER_PORT` (default `8642`), and a strong `API_SERVER_KEY` (generate one if missing and write it with `0600` permissions; never print its value).
     - Restart the Hermes gateway for that exact account/profile and verify both `/health` and authenticated `GET /v1/capabilities`.
   - **OpenClaw (`kind: openclaw`)**:
     - Reuse the OpenClaw Gateway WebSocket v4 (default `127.0.0.1:18789`) with `gateway.auth.mode` set to `token` and a configured gateway token.
     - Note whether device pairing is currently required (`openclaw devices list`) so the local agent knows to expect first-connection pairing.
   - **Remote dsh (`kind: dsh`)**:
     - Reuse the native `dsh web` HTTP API (default port `18790`).
     - Keep `dsh web` on loopback (`127.0.0.1`) behind a private reverse proxy such as Tailscale Serve (adding `--trusted-host <advertised-host>` when accessed through a proxy or advertised hostname), OR bind it directly to a concrete private network interface with `--host <private-ip>` (and add `--trusted-host <advertised-host>` if clients reach it via a hostname or proxy authority other than the bound IP).
     - Verify the launch token works locally against `/connect?token=...&interactions=none` without printing the token or tokenized URL.
   - **ACP v1 (`kind: acp`, including Claude Code)**:
     - If `Network choice` is `same-host` and a local ACP v1 stdio binary is installed (for example `claude-code-acp` or `hermes acp`), verify the binary path and executable permissions — no network listener is needed.
     - If connecting **remotely** over the network: dsh-knot requires a compatible, Bearer-authenticated **ACP v1 WebSocket** endpoint (`ws://` or `wss://`, path `/acp`, enforcing `Authorization: Bearer <token>` and negotiating ACP v1).
       - If a compatible authenticated ACP v1 WebSocket server or bridge is already running/available for this harness, verify it (for native Hermes/OpenClaw/dsh, prefer their native interfaces above; `dsh-knot-acp` only bridges `hermes`, `openclaw`, and `dsh`).
       - **CRITICAL BLOCKER CHECK**: If the target is Claude Code (or another stdio-only ACP agent) on a remote host and no compatible authenticated ACP v1 WebSocket bridge is installed, **STOP immediately** and report clearly:
         - Exact blocker: remote Claude Code requires a compatible, Bearer-authenticated ACP v1 WebSocket bridge wrapping `claude-code-acp`, and `dsh-knot-acp` does not wrap generic stdio ACP binaries (it only bridges `hermes`, `openclaw`, and `dsh`).
         - Do not build an unauthenticated WebSocket proxy or fall back to SSH.
         - Offer the concrete paths forward (run Claude Code on the same host as `dsh` via ACP stdio, deploy a compatible authenticated ACP v1 WebSocket bridge, or connect Hermes/OpenClaw/remote dsh instead).

3. Configure or reuse the private network:
   - Priority: reuse an existing private network first (`headscale`, `tailscale`, `wireguard`, or trusted `lan`) unless I explicitly requested another choice.
   - **Tailscale**: If not installed, install Tailscale using the official method for this OS (Linux/macOS/Windows). Join the specified tailnet (pause and give me the exact auth URL only if interactive login is needed). Keep the gateway bound to `127.0.0.1` and expose it privately:
     - Hermes / Remote dsh / ACP WebSocket: configure `tailscale serve --bg http://127.0.0.1:<port>` and verify HTTPS/WSS reachability.
     - OpenClaw: set `gateway.tailscale.mode` to `serve` in OpenClaw config and restart the gateway (or if reusing an external Serve route, verify OpenClaw's proxy attribution settings).
   - **Existing Headscale**: Reuse the enrolled Tailscale/Headscale node and private hostname/IP. Do NOT log out or overwrite the Headscale `--login-server`.
   - **Existing WireGuard**: Reuse the existing encrypted interface. Bind the gateway or proxy only to the WireGuard IP and verify reachability.
   - **Private LAN**: Bind the gateway or reverse proxy only to the private IP. For a credentialed gateway, provide an HTTPS or WSS endpoint with a certificate the local client trusts.
   - **Same-host**: Keep loopback (`127.0.0.1`) or local ACP stdio only.

4. Output a single clean handoff block at the end that I can forward directly to my local dsh agent. Include ONLY safe credential references (file path + env/key name, or command to view securely) — NEVER plaintext secrets or URLs containing `?token=`, usernames, passwords, queries, or fragments:

```yaml
dsh_knot_handoff:
  agent_id: "<chosen-id>"
  protocol: "<hermes | openclaw | dsh | acp>"
  transport: "<direct | local>"
  acp_transport: "<websocket | stdio | none>"
  network: "<tailscale | headscale | wireguard | lan | same-host>"
  tailnet_or_network_hint: "<tailnet name, headscale domain, wg interface, or LAN subnet>"
  endpoint_url: "<clean https:// / http:// / wss:// / ws:// URL without credentials or query; or omit for stdio>"
  acp_command: "<absolute path to stdio binary if acp_transport is stdio; otherwise omit>"
  acp_args: []
  credential_type: "<hermes_api_key | openclaw_gateway_token | dsh_launch_token | acp_bearer_token | none>"
  credential_reference: "<safe location only, e.g. 'API_SERVER_KEY in ~svc/.hermes/.env' — NEVER the secret value>"
  pairing_status: "<not_required | paired | pending_first_connection>"
  pairing_hint: "<e.g. 'If first test asks for pairing, run openclaw devices list && openclaw devices approve <id> on host'>"
  checks_completed:
    - "<check 1 and verified result>"
    - "<check 2 and verified result>"
  blocker: "<leave empty unless blocked, e.g. missing authenticated ACP v1 WebSocket bridge for remote Claude Code>"
```
````

---

## Step 2 — Prompt for the Local `dsh` Agent

Copy the handoff block from Step 1, paste it at the bottom of **Prompt 2**, and send it to your local `dsh` agent:

```text
Connect this local DeepSeek Harness (dsh) instance to the remote (or same-host) agent described in the handoff block below using dsh-knot (https://github.com/Weaxs/dsh-knot).

Operating rules:
1. Do all routine discovery, installation, configuration, connection diagnostics, and smoke testing yourself. Do NOT hand me a manual setup checklist.
2. Only pause and ask me to act when human input is genuinely required:
   - Interactive network login or OS permission approval (for example Tailscale login / macOS system extension approval).
   - Securely providing or entering the gateway secret (if it is not already present in my local environment or dsh-knot store) — never echo, log, or paste plaintext secrets back into chat.
   - Approving first-time OpenClaw device pairing on the gateway host.
3. Never create SSH tunnels, disable TLS verification, or bypass authentication.

Task steps:
1. Inspect the handoff block first:
   - If `blocker` is non-empty (for example, a remote Claude Code host without a compatible authenticated ACP v1 WebSocket bridge), stop immediately, explain the exact blocker clearly, and state my concrete options instead of creating a broken entry.

2. Locate my active local `dsh` setup:
   - Detect which `dsh` binary, `$DSH_HOME` (default `~/.dsh`), active profile, `settings.yaml` / `cordis.patch.yml`, and running `dsh web` instance I actually use.
   - Check whether `@weaxs/dsh-knot` (or `dsh-knot`) is installed and enabled in that active `dsh` instance.
   - If not installed or not enabled, install and enable `@weaxs/dsh-knot` for that active `dsh` setup (and reload/restart `dsh` only if required, telling me briefly if a UI refresh is needed).

3. Verify local private-network connectivity (skip if `network` is `same-host`):
   - **Tailscale**: Check if Tailscale is installed and connected to the matching tailnet (`tailnet_or_network_hint`). If missing, install Tailscale for my local OS and start login — pause only for my interactive login or OS permission approval.
   - **Headscale / WireGuard / Private LAN**: Verify this machine can resolve and reach the handoff `endpoint_url` host over the existing private network without changing my existing VPN/Headscale control server. For a Headscale or WireGuard endpoint using HTTP or WS, verify that the route actually uses the encrypted overlay. If unreachable, report the exact failing network hop.

4. Add or update the agent connection in **Remote Agents / 远端助手**:
   - Map the handoff fields cleanly:
     - Agent ID: `agent_id`
     - Protocol (`kind`): `protocol` (`hermes`, `openclaw`, `dsh`, or `acp`)
     - Transport: `direct` for networked URLs (Tailscale/Headscale/WireGuard/LAN), or `local` for same-host loopback / ACP stdio (`acpTransport: stdio`, `acpCommand`, `acpArgs`).
     - Endpoint URL: clean `endpoint_url` with no credentials, query string, or fragment.
     - For HTTP or WS over a verified, authenticated encrypted private network, select the encrypted private network checkbox or set `encryptedOverlay: true` via `agent-save` or declarative configuration. For an ordinary LAN gateway carrying credentials, use HTTPS or WSS.
   - Credential handling:
     - **Saving via Remote Agents (`/api/dsh-knot/agent-save` or panel UI)**:
       - Note that saving a **new** connection (or changing a gateway endpoint) without an explicit `token` writes `token: ""` and clears `tokenEnv`, which intentionally disables ambient environment-variable fallback.
       - If `credential_type` is not `none`:
         - When updating an **unchanged** gateway endpoint that already has a saved token, omit `token` to preserve it.
         - When creating a new connection (or changing the endpoint), if the exact gateway's secret is already available locally (for example in the matching local env var `HERMES_API_KEY`, `OPENCLAW_GATEWAY_TOKEN`, `DSH_GATEWAY_TOKEN`, or `DSH_KNOT_ACP_TOKEN`, or a local secret file), pass that secret in the `token` field when saving — never echo or log the secret value.
         - Otherwise, pause and ask me to enter the secret directly in **Remote Agents → + Add Agent / Edit** (saved to the active `agents.json` state file — `$DSH_KNOT_STATE_DIR/agents.json` when `DSH_KNOT_STATE_DIR` is set, otherwise `$DSH_HOME/knot/agents.json` / `~/.dsh/knot/agents.json` — with `0600` permissions), referencing `credential_reference` so I know which secret to copy.
     - **Env-only declarative config path (optional)**:
       - If I prefer not to store the token in the local state file (`$DSH_KNOT_STATE_DIR/agents.json` when `DSH_KNOT_STATE_DIR` is set in the active `dsh` process, otherwise `$DSH_HOME/knot/agents.json`, default `~/.dsh/knot/agents.json`), configure the agent declaratively in plugin settings with `tokenEnv` (for example `tokenEnv: HERMES_API_KEY`) and omit `token`, ensure that env var is present in the running `dsh` process environment, and reload/restart `dsh` for the declarative config to take effect (do not overwrite it with an empty-token save through Remote Agents).
       - **Important when switching an existing `agent_id` to `tokenEnv`**: entries already stored in the active `agents.json` state file (`agents`) override declarative plugin config entries with the same ID on reload, and previously deleted IDs (`deletedIds`) suppress them. Resolve the active state directory from the running `dsh` process (`DSH_KNOT_STATE_DIR` takes precedence over `DSH_HOME/knot` and `~/.dsh/knot`), then either choose a fresh `agent_id` or remove the matching entry from `agents` and `deletedIds` in that active `agents.json` before reloading `dsh`.
   - Save or update the agent in **Remote Agents** (using the active `dsh` instance's Remote Agents state/API so it appears immediately in the **Remote Agents / 远端助手** panel, unless using the declarative `tokenEnv` path above).

5. Run connection diagnostics:
   - Run `knot_doctor` (or trigger **Test all connections / Retest** in Remote Agents) targeting `agent_id`.
   - If `protocol` is `openclaw` and diagnostics report pairing / device approval required:
     - Pause and give me the exact commands to run on the OpenClaw gateway host:
       `openclaw devices list`
       `openclaw devices approve <requestId>`
     - Once I confirm approval, rerun `knot_doctor` and verify `gateway-health` passes.
   - Do not proceed until `knot_doctor` reports healthy connectivity.

6. Send a side-effect-free live verification message:
   - Use `agent_ask` (with `wait: true`) — or the Remote Agents Chat flow — to send this exact prompt to `agent_id`:
     `Connectivity check only: reply with exactly DSH_KNOT_OK. Do not run any tools, commands, or file edits.`
   - Confirm you receive a real reply from the remote agent containing `DSH_KNOT_OK` (no fabricated success, no error status).

7. Report completion concisely:
   - Agent ID, protocol, network, verified endpoint, `knot_doctor` status, and the test reply received.
   - Confirm that the agent is now ready to use in **Remote Agents / 远端助手** and via `agent_ask` / `agent_continue`.

Handoff block from the server agent:
<PASTE_HANDOFF_BLOCK_HERE>
```

---

## When Human Intervention Is Expected

The two agents handle discovery, package installation, service restarts, config updates, diagnostics, and smoke testing automatically. You should only be asked to step in for:

1. **Network login or OS authorization**: Tailscale interactive SSO login URL or macOS/Windows VPN extension approval.
2. **Entering a secret safely**: Typing or pasting the gateway token into **Remote Agents / 远端助手** (saved to `$DSH_KNOT_STATE_DIR/agents.json` when set, otherwise `$DSH_HOME/knot/agents.json`, with `0600` permissions) or a protected local env file, without exposing it in chat transcripts.
3. **OpenClaw first-time device pairing**: Running `openclaw devices list` and `openclaw devices approve <requestId>` on the OpenClaw host after `dsh-knot` creates its Ed25519 key in `$DSH_HOME/knot/devices`.
4. **Remote stdio-only ACP agents (such as remote Claude Code)**: Deciding how to proceed if no compatible Bearer-authenticated ACP v1 WebSocket bridge is installed on the remote host.
