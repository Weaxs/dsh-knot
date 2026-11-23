#!/usr/bin/env bash
set -euo pipefail

mode="${1:?usage: run-compose.sh local|tailscale|headscale hermes|openclaw|dsh}"
target="${2:?usage: run-compose.sh local|tailscale|headscale hermes|openclaw|dsh}"
case "$mode" in local|tailscale|headscale) ;; *) echo "unknown mode $mode" >&2; exit 2 ;; esac
case "$target" in hermes|openclaw|dsh) ;; *) echo "unknown target $target" >&2; exit 2 ;; esac
export E2E_TARGET="$target" E2E_PROTOCOL="${E2E_PROTOCOL:-native}"
case "$E2E_PROTOCOL" in native|acp) ;; *) echo "unknown protocol $E2E_PROTOCOL" >&2; exit 2 ;; esac
export COMPOSE_PROFILES="$target"
if [[ "$E2E_PROTOCOL" == acp ]]; then export COMPOSE_PROFILES="$target,acp"; fi

root="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$root"
mkdir -p .github/e2e/generated/dsh
project="dsh-knot-e2e-$mode-$target-$E2E_PROTOCOL"
files=(-f .github/e2e/compose.yml -f ".github/e2e/compose.$mode.yml")
compose=(docker compose -p "$project" "${files[@]}")

cleanup() {
  status=$?
  set +e
  local log=".github/e2e/generated/e2e-$mode-$target-$E2E_PROTOCOL.log"
  "${compose[@]}" logs --no-color > "$log" 2>&1
  if [[ "$mode" == tailscale ]]; then
    # If logout cannot finish, the ephemeral device ages out after it disconnects.
    "${compose[@]}" exec -T "${target}-tailscale" timeout 8s tailscale --socket=/tmp/tailscaled.sock logout >> "$log" 2>&1
  fi
  "${compose[@]}" down -v --remove-orphans >> "$log" 2>&1
  if [[ "$mode" == headscale && -f "${RUNNER_TEMP:-/tmp}/headscale-e2e.log" ]]; then
    cp "${RUNNER_TEMP:-/tmp}/headscale-e2e.log" .github/e2e/generated/headscale-$target-$E2E_PROTOCOL-daemon.log
  fi
  if [[ "$mode" == headscale && -n "${TS_SOCKET:-}" ]]; then
    sudo tailscale --socket="$TS_SOCKET" down >/dev/null 2>&1
    sudo pkill -f 'tailscaled.*headscale-e2e.state' >/dev/null 2>&1
  fi
  exit "$status"
}
trap cleanup EXIT

: "${HERMES_API_KEY:=e2e-hermes-gateway-token}"
: "${OPENCLAW_GATEWAY_TOKEN:=e2e-openclaw-gateway-token}"
export HERMES_API_KEY OPENCLAW_GATEWAY_TOKEN
case "$target" in
  hermes) export E2E_NATIVE_PORT=8642 E2E_NATIVE_TOKEN="$HERMES_API_KEY" ;;
  openclaw) export E2E_NATIVE_PORT=18789 E2E_NATIVE_TOKEN="$OPENCLAW_GATEWAY_TOKEN" ;;
  dsh) export E2E_NATIVE_PORT=18790 E2E_NATIVE_TOKEN="" ;;
esac
export E2E_NODE_SUFFIX="${E2E_NODE_SUFFIX:-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}-$E2E_PROTOCOL}"
if [[ "$mode" == headscale ]]; then
  export HEADSCALE_AUTHKEY="${HEADSCALE_AUTHKEY:-pending}"
  export HEADSCALE_GATEWAY_IP="${HEADSCALE_GATEWAY_IP:-$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}')}"
  sed "s|__HEADSCALE_GATEWAY_IP__|${HEADSCALE_GATEWAY_IP}|g" .github/e2e/headscale/config.yaml > .github/e2e/generated/headscale-config.yaml
fi
export E2E_CONTAINER_OPENAI_BASE_URL="$(node -e "process.stdout.write(process.env.OPENAI_BASE_URL.replace(/^(https?:\\/\\/)(?:127\\.0\\.0\\.1|localhost)(?=[:/]|$)/,'\$1host.docker.internal'))")"
model_exports="$(node .github/e2e/scripts/model-network.mjs)"
eval "$model_exports"

npm run build
node .github/e2e/scripts/write-config.mjs
"${compose[@]}" config --quiet

case "$mode" in
  local)
    export E2E_TRANSPORT=local E2E_MODE_LABEL=local HERMES_PORT=18642 OPENCLAW_PORT=18789 DSH_PORT=18790
    ;;
  tailscale)
    if [[ -z "${TAILSCALE_AUTHKEY:-}" ]]; then
      echo 'TAILSCALE_AUTHKEY is required for the real Tailscale E2E job' >&2
      exit 1
    fi
    export E2E_TRANSPORT=direct E2E_MODE_LABEL=tailscale HERMES_PORT=8642 OPENCLAW_PORT=18789 DSH_PORT=18790
    ;;
  headscale)
    export E2E_TRANSPORT=direct E2E_MODE_LABEL=headscale HERMES_PORT=8642 OPENCLAW_PORT=18789 DSH_PORT=18790
    "${compose[@]}" up -d headscale
    for _ in {1..60}; do
      if "${compose[@]}" exec -T headscale headscale users list >/dev/null 2>&1; then break; fi
      sleep 2
    done
    "${compose[@]}" exec -T headscale headscale users create e2e || true
    key_json="$("${compose[@]}" exec -T headscale headscale preauthkeys create --user 1 --reusable --expiration 10m -o json)"
    export HEADSCALE_AUTHKEY="$(node -e "const s=process.argv[1];try{const j=JSON.parse(s);process.stdout.write(j.key??j.preAuthKey??j.authKey??s.trim())}catch{process.stdout.write(s.trim())}" "$key_json")"
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

node .github/e2e/run.mjs 2>&1 | tee ".github/e2e/generated/adapter-$mode-$target-$E2E_PROTOCOL.log"
