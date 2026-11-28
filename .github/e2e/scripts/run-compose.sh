#!/usr/bin/env bash
set -euo pipefail

mode="${1:?usage: run-compose.sh local|tailscale|headscale hermes|openclaw|dsh}"
target="${2:?usage: run-compose.sh local|tailscale|headscale hermes|openclaw|dsh}"
case "$mode" in local|tailscale|headscale) ;; *) echo "unknown mode $mode" >&2; exit 2 ;; esac
case "$target" in hermes|openclaw|dsh) ;; *) echo "unknown target $target" >&2; exit 2 ;; esac
if [[ "$target" == hermes && "$mode" != local ]]; then
  echo 'The Hermes ACP E2E case uses stdio inside the local Compose container.' >&2
  exit 2
fi
protocol=paseo
if [[ "$target" == dsh ]]; then protocol=native; fi
if [[ -n "${E2E_PROTOCOL:-}" && "$E2E_PROTOCOL" != "$protocol" ]]; then
  echo "$target uses $protocol in the E2E matrix" >&2
  exit 2
fi
export E2E_TARGET="$target" E2E_PROTOCOL="$protocol" COMPOSE_PROFILES="$target"

root="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$root"
mkdir -p .github/e2e/generated/dsh
project="dsh-knot-e2e-$mode-$target-$E2E_PROTOCOL"
openclaw_client_dir=""
paseo_test_dir=""
paseo_test_pid=""
files=(-f "$root/.github/e2e/compose.yml" -f "$root/.github/e2e/compose.$mode.yml")
compose=(docker compose -p "$project" "${files[@]}")

cleanup() {
  status=$?
  set +e
  if [[ -n "$openclaw_client_dir" ]]; then rm -rf "$openclaw_client_dir"; fi
  local log=".github/e2e/generated/e2e-$mode-$target-$E2E_PROTOCOL.log"
  if [[ -n "$paseo_test_pid" ]]; then
    kill "$paseo_test_pid" 2>/dev/null || true
    wait "$paseo_test_pid" 2>/dev/null || true
  fi
  if [[ -n "$paseo_test_dir" ]]; then
    cp "$paseo_test_dir/daemon.log" ".github/e2e/generated/paseo-$mode-$target-daemon.log" 2>/dev/null || true
    rm -rf "$paseo_test_dir"
  fi
  "${compose[@]}" logs --no-color > "$log" 2>&1
  if [[ "$mode" == tailscale ]]; then
    if "${compose[@]}" exec -T "${target}-tailscale" timeout 20s tailscale --socket=/tmp/tailscaled.sock logout 2>&1 | tee -a "$log"; then
      echo "Logged out the $target Tailscale sidecar."
    else
      echo "::warning::Could not log out the $target Tailscale sidecar. An inactive ephemeral device will age out."
    fi
  fi
  "${compose[@]}" down -v --remove-orphans >> "$log" 2>&1
  if [[ "$mode" == headscale && -f "${RUNNER_TEMP:-/tmp}/headscale-e2e.log" ]]; then
    cp "${RUNNER_TEMP:-/tmp}/headscale-e2e.log" ".github/e2e/generated/headscale-$target-$E2E_PROTOCOL-daemon.log"
  fi
  if [[ "$mode" == headscale && -n "${TS_SOCKET:-}" ]]; then
    sudo tailscale --socket="$TS_SOCKET" down >/dev/null 2>&1
    sudo pkill -f 'tailscaled.*headscale-e2e.state' >/dev/null 2>&1
  fi
  exit "$status"
}
trap cleanup EXIT

: "${OPENCLAW_GATEWAY_TOKEN:=e2e-openclaw-gateway-token}"
export OPENCLAW_GATEWAY_TOKEN
export E2E_NODE_SUFFIX="${E2E_NODE_SUFFIX:-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}-$E2E_PROTOCOL}"
if [[ "$mode" == headscale ]]; then
  export HEADSCALE_AUTHKEY="${HEADSCALE_AUTHKEY:-pending}"
  export HEADSCALE_GATEWAY_IP="${HEADSCALE_GATEWAY_IP:-$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}')}"
  sed "s|__HEADSCALE_GATEWAY_IP__|${HEADSCALE_GATEWAY_IP}|g" .github/e2e/headscale/config.yaml > .github/e2e/generated/headscale-config.yaml
fi
E2E_CONTAINER_OPENAI_BASE_URL="$(node -e "process.stdout.write(process.env.OPENAI_BASE_URL.replace(/^(https?:\\/\\/)(?:127\\.0\\.0\\.1|localhost)(?=[:/]|$)/,'\$1host.docker.internal'))")"
export E2E_CONTAINER_OPENAI_BASE_URL
model_exports="$(node .github/e2e/scripts/model-network.mjs)"
eval "$model_exports"

npm run build
node .github/e2e/scripts/write-config.mjs
"${compose[@]}" config --quiet

case "$mode" in
  local)
    export E2E_TRANSPORT=local E2E_MODE_LABEL=local OPENCLAW_PORT=18789 DSH_PORT=18790
    ;;
  tailscale)
    if [[ -z "${TAILSCALE_AUTHKEY:-}" ]]; then
      echo 'TAILSCALE_AUTHKEY is required for the real Tailscale E2E job' >&2
      exit 1
    fi
    export E2E_TRANSPORT=direct E2E_MODE_LABEL=tailscale OPENCLAW_PORT=18789 DSH_PORT=18790
    ;;
  headscale)
    export E2E_TRANSPORT=direct E2E_MODE_LABEL=headscale OPENCLAW_PORT=18789 DSH_PORT=18790
    "${compose[@]}" up -d headscale
    for _ in {1..60}; do
      if "${compose[@]}" exec -T headscale headscale users list >/dev/null 2>&1; then break; fi
      sleep 2
    done
    "${compose[@]}" exec -T headscale headscale users create e2e || true
    key_json="$("${compose[@]}" exec -T headscale headscale preauthkeys create --user 1 --reusable --expiration 10m -o json)"
    HEADSCALE_AUTHKEY="$(node -e "const s=process.argv[1];try{const j=JSON.parse(s);process.stdout.write(j.key??j.preAuthKey??j.authKey??s.trim())}catch{process.stdout.write(s.trim())}" "$key_json")"
    export HEADSCALE_AUTHKEY
    if [[ -z "$HEADSCALE_AUTHKEY" ]]; then echo 'Could not create a Headscale preauth key' >&2; exit 1; fi
    if ! command -v tailscaled >/dev/null; then
      tailscale_version="${TAILSCALE_E2E_VERSION:-1.104.7}"
      tailscale_archive="${RUNNER_TEMP:-/tmp}/tailscale-e2e.tgz"
      curl -fsSL "https://pkgs.tailscale.com/stable/tailscale_${tailscale_version}_amd64.tgz" -o "$tailscale_archive"
      tar -xzf "$tailscale_archive" -C "${RUNNER_TEMP:-/tmp}"
      sudo install -m 0755 "${RUNNER_TEMP:-/tmp}/tailscale_${tailscale_version}_amd64/tailscale" /usr/local/bin/tailscale
      sudo install -m 0755 "${RUNNER_TEMP:-/tmp}/tailscale_${tailscale_version}_amd64/tailscaled" /usr/local/bin/tailscaled
    fi
    export TS_SOCKET="${RUNNER_TEMP:-/tmp}/headscale-e2e.sock"
    export E2E_TAILSCALE_SUDO=1
    # Write the runner-owned log before sudo starts the daemon.
    # shellcheck disable=SC2024
    sudo tailscaled --tun=dshknot-e2e --state="${RUNNER_TEMP:-/tmp}/headscale-e2e.state" --socket="$TS_SOCKET" >"${RUNNER_TEMP:-/tmp}/headscale-e2e.log" 2>&1 &
    for _ in {1..30}; do
      if sudo tailscale --socket="$TS_SOCKET" status >/dev/null 2>&1; then break; fi
      sleep 1
    done
    sudo tailscale --socket="$TS_SOCKET" up --timeout=60s --netfilter-mode=off --login-server="http://${HEADSCALE_GATEWAY_IP}:28080" --authkey="$HEADSCALE_AUTHKEY" --hostname="runner-e2e-${E2E_NODE_SUFFIX}" --accept-dns=false --reset
    ;;
esac

"${compose[@]}" up -d --wait

if [[ "$mode" == tailscale || "$mode" == headscale ]]; then
  connected=false
  for _ in {1..45}; do
    if tailscale_exports="$(node .github/e2e/scripts/tailscale-env.mjs)"; then
      eval "$tailscale_exports"
      connected=true
      break
    fi
    sleep 2
  done
  if [[ "$connected" != true ]]; then echo 'Tailscale peers did not become available' >&2; exit 1; fi
fi

if [[ "$target" == dsh ]]; then
  token_ready=false
  for _ in {1..60}; do
    if [[ -s .github/e2e/generated/dsh/token ]]; then token_ready=true; break; fi
    sleep 2
  done
  if [[ "$token_ready" != true ]]; then echo 'DSH launch token was not written' >&2; exit 1; fi
  DSH_GATEWAY_TOKEN="$(cat .github/e2e/generated/dsh/token)"
  export DSH_GATEWAY_TOKEN
  if [[ -z "${DSH_GATEWAY_TOKEN:-}" ]]; then echo 'DSH launch token is empty' >&2; exit 1; fi
  echo "DSH launch token loaded (${#DSH_GATEWAY_TOKEN} characters)"
fi

case "$target" in
  hermes)
    "${compose[@]}" exec -T --user hermes hermes sh -ec '
      mkdir -p /tmp/knot-hermes
      cp /tmp/knot-hermes-config.yaml /tmp/knot-hermes/config.yaml
    '
    acp_command=(docker compose -p "$project" "${files[@]}" exec -T --user hermes -w /tmp
      -e HOME=/tmp/knot-hermes -e HERMES_HOME=/tmp/knot-hermes hermes /opt/hermes/.venv/bin/hermes acp)
    ;;
  openclaw)
    openclaw_client_dir="$(mktemp -d)"
    openclaw_token_file="$openclaw_client_dir/token"
    (umask 077; printf '%s' "$OPENCLAW_GATEWAY_TOKEN" > "$openclaw_token_file")
    gateway="ws://${OPENCLAW_HOST:-127.0.0.1}:${OPENCLAW_PORT}"
    if command -v openclaw >/dev/null; then
      acp_command=(env OPENCLAW_STATE_DIR="$openclaw_client_dir/state"
        OPENCLAW_HIDE_BANNER=1 OPENCLAW_SUPPRESS_NOTES=1 openclaw acp --url "$gateway" --token-file "$openclaw_token_file")
    else
      acp_command=(docker run --rm -i --network host --entrypoint node --user "$(id -u):$(id -g)"
        -e HOME=/run/dsh-knot -e OPENCLAW_STATE_DIR=/run/dsh-knot/state
        -e OPENCLAW_HIDE_BANNER=1 -e OPENCLAW_SUPPRESS_NOTES=1
        --mount "type=bind,src=$openclaw_client_dir,dst=/run/dsh-knot"
        openclaw/openclaw:latest openclaw.mjs acp --url "$gateway" --token-file /run/dsh-knot/token)
    fi
    ;;
esac
if [[ "$target" != dsh ]]; then
  paseo_test_dir="$(mktemp -d)"
  mkdir -p "$paseo_test_dir/home"
  export E2E_PASEO_CWD=/tmp
  E2E_PASEO_PORT="$(node --input-type=module -e "import { createServer } from 'node:net'; const s=createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()});")"
  E2E_PASEO_PASSWORD="$(node --input-type=module -e "import { randomBytes } from 'node:crypto'; console.log(randomBytes(24).toString('hex'));")"
  export E2E_PASEO_PORT E2E_PASEO_PASSWORD
  if [[ "$target" == hermes ]]; then export E2E_PASEO_PROVIDER=hermes; else export E2E_PASEO_PROVIDER=openclaw-e2e; fi
  node --input-type=module - "$paseo_test_dir/home/config.json" "${acp_command[@]}" <<'JS'
import { writeFileSync } from 'node:fs';
const [file, ...command] = process.argv.slice(2);
const id = process.env.E2E_PASEO_PROVIDER;
const provider = id === 'hermes' ? { enabled: true, command } : { extends: 'acp', label: 'OpenClaw', command };
writeFileSync(file, JSON.stringify({ version: 1, agents: { providers: { [id]: provider } } }), { mode: 0o600 });
JS
  if [[ -n "${KNOT_PASEO_CLI:-}" ]]; then
    paseo_cli="$KNOT_PASEO_CLI"
  else
    npm install --prefix "$paseo_test_dir/cli" --no-fund --no-audit @getpaseo/cli@0.18.1
    paseo_cli="$paseo_test_dir/cli/node_modules/.bin/paseo"
  fi
  PASEO_LISTEN="127.0.0.1:$E2E_PASEO_PORT" PASEO_RELAY_ENABLED=false PASEO_PASSWORD="$E2E_PASEO_PASSWORD" \
    "$paseo_cli" daemon run --home "$paseo_test_dir/home" >"$paseo_test_dir/daemon.log" 2>&1 &
  paseo_test_pid=$!
fi

node .github/e2e/run.mjs 2>&1 | tee ".github/e2e/generated/adapter-$mode-$target-$E2E_PROTOCOL.log"
