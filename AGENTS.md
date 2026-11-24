# dsh-knot agent guide

## Workflow

1. **Scope.** Read the applicable references before editing or reviewing. For code, trace the existing entry point and its tests so you know which contracts the diff touches.
2. **Change.** Make the smallest change that fixes the behavior at its owning layer. Reuse existing helpers and tests. Update affected callers, tests, and user documentation when a public contract changes.
3. **Verify.** For code, start with the narrowest check (`npx vitest run tests/<file>.test.ts -t '<case>'`) and exercise the affected entry point and failure paths. For docs, verify the changed links, commands, and claims against their sources. Review your full diff, fix confirmed issues in scope, then rerun affected checks and review the updated diff until no actionable issue remains. Report any blocked check.

## Read by task

- For **protocol, transport, job, or MCP changes**, read the matching sections of [DESIGN.md](docs/DESIGN.md). Adapters own protocol messages and emit normalized `AgentEvent`s. Transports own connectivity. Use the shared ACP v1 provider for compatible endpoints. The ACP bridge reuses native adapters through normalized events.
- For **dsh host integration**, start with the [plugin entry](src/index.ts) and the affected host call, such as [model tool registration](src/tools.ts). Verify changed calls against installed `@deepseek-ai/*` types or matching host source, including `defineTool` and `sessionController` methods `list`, `events`, and `follow` as applicable.
- For **Remote Agents UI**, read the [dashboard behavior](README.md#web-ui-dashboard), then trace the affected operation through the [client](src/client/index.ts) and [Web routes](src/web/routes.ts). Use the [job and transcript semantics](docs/DESIGN.md#jobs-and-model-tools) for chat state changes. Start with the [UI and route tests](tests/web-routes.test.ts) and exercise the changed interaction in `dsh web` when available.
- For **installation**, use the [install guide](README.md#install). For **configuration**, use the [quick start](README.md#quick-start). For an **agent handoff**, use the [two-prompt setup guide](docs/TWO_PROMPT_SETUP.md).
- For **live gateway validation**, read [E2E.md](docs/E2E.md) for the model-backed matrix, credentials, and pass criteria. Verify model output and same-session continuation. Record exactly which live cases ran and which were skipped.
- For **packaging or release**, read [Development & Release](README.md#development--release) and the [release workflow](.github/workflows/release.yml).

## Code conventions

- Use English for code, comments, test descriptions, documentation, commits, and PRs. Keep translated UI strings in their target language.
- Follow the TypeScript settings and explicit `.js` import convention. Add dependencies only when they remove substantial protocol or security complexity. Reserve comments for protocol and lifecycle behavior that needs explanation.

## Guardrails

- Keep connections direct and private. A relay, cloud broker, or mandatory remote plugin requires an explicit request. Preserve [credential transport](docs/DESIGN.md#transports) and [ACP bridge authentication](docs/DESIGN.md#acp-v1-provider-and-bridge).
- Keep MCP on a separate, read-only listener. Fail closed on missing credentials, reject wildcard binds, and check the session allow-list before reading data. An empty list shares nothing. Use constant-time bearer verification and circular-safe recursive redaction. Keep credentials, full remote configs, and session contents out of logs.
- Surface structured gateway errors, partial output, and approval requests. Wait for the user's decision on remote approvals and scope pending permissions by session. Use documented fallbacks for the failures they cover. Limit ignored errors to best-effort cleanup and notification delivery, and explain those exceptions at the error handler.
- Register dsh tools with `defineTool`. Preserve tool names and the single JSON text block unless changing the public contract deliberately. Forward `exec.signal` to tool-initiated network calls, waits, diagnostics, and cancellation. Keep `Agent.followup()` optional and best-effort. Use `ctx.effect()` for unload cleanup and keep dsh host dependencies as peers.
- Bound retained jobs, runs, cursors, session maps, queues, and payloads. Evict finished entries. Release abort listeners, timers, streams, sockets, and subprocesses on every exit path.
- Cancel or reuse pending `AsyncQueue.next()` reads in races. Decode split UTF-8 with `StringDecoder` or concatenate bytes before decoding. Handle stream errors on HTTP error responses. Run generator fallbacks after iteration so cleanup preserves stream errors.
- Cancel the local job. If it owns a remote turn, request a stop for that turn and preserve any stream needed for terminal confirmation. Keep unconfirmed stops distinct from confirmed stops, and prevent late completion or retry from overwriting cancellation or stopping a newer turn.

## Before commit or release

- Run `npm run check` for substantial changes and releases. For other commits, run `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`. Stage only reviewed files and exclude generated output, temporary files, and credentials.
- Publish through GitHub Actions. Keep both npm packages behaviorally identical. When changing packaging, verify the package identity in each packed Cordis patch and client bundle. Verify tag, package, and runtime version alignment before releasing.
- Report unit and protocol tests, build, live-host validation, and remaining protocol assumptions separately. Count only model-backed runs through real gateways as live E2E.
