import type { Context } from '@deepseek-ai/cordis';
import { normalizeConfig } from '../config.js';
import { runDoctor } from '../doctor.js';
import type { AgentManager } from '../manager.js';
import type { McpServer } from '../mcp/server.js';
import type { SessionControllerLike } from '../mcp/session-service.js';
import { redact, redactTextSegments } from '../policy/redact.js';
import { updateStoredState } from '../store.js';
import type { AgentConfig, AgentJob } from '../types.js';
import { VERSION } from '../version.js';

interface ConnectionHostFace {
  fetch?: {
    register?(route: {
      path: string;
      methods: readonly string[];
      requestBody: 'buffered';
      fetch: (request: Request) => Response | Promise<Response>;
    }): () => void;
  };
}

export const WEB_ROUTES = {
  state: '/api/dsh-knot/state',
  doctor: '/api/dsh-knot/doctor',
  ask: '/api/dsh-knot/ask',
  job: '/api/dsh-knot/job',
  respond: '/api/dsh-knot/respond',
  cancel: '/api/dsh-knot/cancel',
  sessions: '/api/dsh-knot/sessions',
  sessionMessages: '/api/dsh-knot/session-messages',
  mcpShare: '/api/dsh-knot/mcp-share',
  agentSave: '/api/dsh-knot/agent-save',
  agentDelete: '/api/dsh-knot/agent-delete',
} as const;

function jsonReply(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
}

function errorReply(message: string, status = 400): Response {
  return jsonReply({ ok: false, error: message }, status);
}

function jobPriority(job: AgentJob): number {
  return Number(job.status === 'queued' || job.status === 'running' || job.remoteStop !== undefined);
}

function redactJob(job: AgentJob): AgentJob {
  if (!job.timeline?.length) return redact(job);
  const timeline = job.timeline.map((entry) => ({ ...entry }));
  const textEntries = timeline.filter((entry) => entry.kind !== 'tool');
  for (const [kind, fullText] of [
    ['text', job.text],
    ['thought', job.thought],
    ['commentary', undefined],
  ] as const) {
    const entries = textEntries.filter((entry) => entry.kind === kind);
    const texts = redactTextSegments(
      entries.map((entry) => entry.text),
      fullText,
    );
    entries.forEach((entry, index) => {
      entry.text = texts[index]!;
    });
  }
  return redact({ ...job, timeline });
}

async function parseBody(request: Request): Promise<Record<string, unknown>> {
  const raw = await request.text();
  if (!raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Request body must be valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

export function registerWebRoutes(
  ctx: Context,
  manager: AgentManager,
  mcp: McpServer | undefined,
  sessions: SessionControllerLike | (() => SessionControllerLike | undefined) | undefined,
): void {
  const resolveSessions = (): SessionControllerLike | undefined =>
    typeof sessions === 'function' ? sessions() : sessions;
  const agentRouteLocks = new Map<string, Promise<void>>();
  const withAgentRouteLock = async <T>(id: string, fn: () => Promise<T>): Promise<T> => {
    const prev = agentRouteLocks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = prev.then(() => next);
    agentRouteLocks.set(id, chained);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (agentRouteLocks.get(id) === chained) agentRouteLocks.delete(id);
    }
  };

  const mountAll = (targetCtx: Context) => {
    const conn =
      typeof (targetCtx as unknown as { get?: (name: string) => unknown }).get === 'function'
        ? ((targetCtx as unknown as { get: (name: string) => unknown }).get('connection') as
            | ConnectionHostFace
            | undefined)
        : (targetCtx as unknown as { connection?: ConnectionHostFace }).connection;
    if (typeof conn?.fetch?.register !== 'function') return;

    const register = (path: string, handler: (request: Request) => Promise<Response>) => {
      const dispose = conn.fetch!.register!({
        path,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: handler,
      });
      targetCtx.effect(() => dispose);
    };

    register(WEB_ROUTES.state, async (request) => {
      try {
        const localSessions: Array<{ sessionId: string; title?: string; cwd?: string; shared: boolean }> = [];
        const allowed = new Set(mcp?.listAllowed() ?? []);
        const currentSessions = resolveSessions();
        if (currentSessions) {
          try {
            const listed = await currentSessions.list({}, request.signal);
            for (const item of listed.items.slice(0, 100)) {
              const id = String(item.sessionId ?? '');
              if (!id) continue;
              localSessions.push(
                redact({
                  sessionId: id,
                  title: item.title ? String(item.title) : undefined,
                  cwd: item.cwd ? String(item.cwd) : undefined,
                  shared: allowed.has(id),
                }),
              );
            }
          } catch {
            /* session list failure should not break the control panel state */
          }
        }
        return jsonReply({
          ok: true,
          value: {
            version: VERSION,
            agents: manager.list(),
            jobs: manager
              .listJobs({ currentOnly: true })
              .sort((a, b) => jobPriority(b) - jobPriority(a))
              .slice(0, 50)
              .map(redactJob),
            mcp: {
              enabled: Boolean(mcp?.address),
              address: mcp?.address ?? null,
              allowSessions: [...allowed],
              localSessions,
            },
          },
        });
      } catch (error) {
        return errorReply(error instanceof Error ? error.message : String(error), 500);
      }
    });

    register(WEB_ROUTES.doctor, async (request) => {
      try {
        const body = await parseBody(request);
        const agent = typeof body.agent === 'string' && body.agent.trim() ? body.agent.trim() : undefined;
        const result = await runDoctor(manager, agent, request.signal);
        return jsonReply({ ok: true, value: redact(result) });
      } catch (error) {
        return errorReply(error instanceof Error ? error.message : String(error), 400);
      }
    });

    const staleGateway = () => errorReply('The gateway configuration changed. Select the conversation again.', 409);

    register(WEB_ROUTES.ask, async (request) => {
      try {
        const body = await parseBody(request);
        const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : '';
        const message = typeof body.message === 'string' ? body.message.trim() : '';
        const sessionId =
          typeof body.sessionId === 'string' && body.sessionId.trim() ? body.sessionId.trim() : undefined;
        if (!agentId) return errorReply('agentId is required', 400);
        if (!message) return errorReply('message is required', 400);
        if (typeof body.revision !== 'string') return errorReply('revision is required', 400);
        if (!manager.matchesRevision(agentId, body.revision)) return staleGateway();
        const clientMessageId = body.clientMessageId;
        if (
          clientMessageId !== undefined &&
          (typeof clientMessageId !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(clientMessageId))
        ) {
          return errorReply('Invalid clientMessageId', 400);
        }
        const job = manager.start(agentId, message, sessionId, undefined, true, clientMessageId);
        return jsonReply({ ok: true, value: redactJob(job) });
      } catch (error) {
        return errorReply(error instanceof Error ? error.message : String(error), 400);
      }
    });

    register(WEB_ROUTES.job, async (request) => {
      try {
        const { agentId, revision, jobId } = await parseBody(request);
        if (typeof agentId !== 'string' || typeof revision !== 'string' || typeof jobId !== 'string' || !jobId) {
          return errorReply('agentId, revision, and jobId are required', 400);
        }
        if (!manager.matchesRevision(agentId, revision)) return staleGateway();
        const job = manager.getCurrentJob(agentId, jobId);
        return job ? jsonReply({ ok: true, value: redactJob(job) }) : errorReply('Job not found for this gateway', 404);
      } catch (error) {
        return errorReply(error instanceof Error ? error.message : String(error), 400);
      }
    });

    register(WEB_ROUTES.respond, async (request) => {
      try {
        const body = await parseBody(request);
        const jobId = typeof body.jobId === 'string' ? body.jobId : '';
        const requestId = typeof body.requestId === 'string' ? body.requestId : '';
        const choice = typeof body.choice === 'string' ? body.choice : '';
        if (!jobId || !requestId || !choice) return errorReply('jobId, requestId, and choice are required', 400);
        const job = await manager.respond(jobId, choice, request.signal, requestId);
        return jsonReply({ ok: true, value: redactJob(job) });
      } catch (error) {
        return errorReply(error instanceof Error ? error.message : String(error), 400);
      }
    });

    register(WEB_ROUTES.cancel, async (request) => {
      try {
        const body = await parseBody(request);
        const jobId = typeof body.jobId === 'string' ? body.jobId : '';
        if (!jobId) return errorReply('jobId is required', 400);
        const job = await manager.cancel(jobId, request.signal);
        return jsonReply({ ok: true, value: redactJob(job) });
      } catch (error) {
        return errorReply(error instanceof Error ? error.message : String(error), 400);
      }
    });

    register(WEB_ROUTES.sessions, async (request) => {
      try {
        const body = await parseBody(request);
        const agentId = typeof body.agentId === 'string' ? body.agentId : '';
        if (!agentId) return errorReply('agentId is required', 400);
        if (typeof body.revision !== 'string') return errorReply('revision is required', 400);
        if (!manager.matchesRevision(agentId, body.revision)) return staleGateway();
        const timeoutMs = manager.getConfig(agentId)?.connectTimeoutMs ?? 15_000;
        const boundedSignal = AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]);
        const items = await manager.adapter(agentId).listSessions(boundedSignal);
        if (!manager.matchesRevision(agentId, body.revision)) return staleGateway();
        return jsonReply({ ok: true, value: { agentId, sessions: redact(items.slice(0, 100)) } });
      } catch (error) {
        return errorReply(error instanceof Error ? error.message : String(error), 400);
      }
    });

    register(WEB_ROUTES.sessionMessages, async (request) => {
      try {
        const { agentId, revision, sessionId } = await parseBody(request);
        if (
          typeof agentId !== 'string' ||
          typeof revision !== 'string' ||
          typeof sessionId !== 'string' ||
          !sessionId.trim() ||
          sessionId.length > 512
        ) {
          return errorReply('agentId, revision, and a valid sessionId are required', 400);
        }
        if (!manager.matchesRevision(agentId, revision)) return staleGateway();
        const adapter = manager.adapter(agentId);
        if (!adapter.getSessionMessages) return errorReply('This gateway does not provide message history', 501);
        const timeoutMs = manager.getConfig(agentId)?.connectTimeoutMs ?? 15_000;
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]);
        const messages = await adapter.getSessionMessages(sessionId, signal);
        if (!manager.matchesRevision(agentId, revision)) return staleGateway();
        return jsonReply({ ok: true, value: { messages: redact(messages) } });
      } catch (error) {
        return errorReply(redact(error instanceof Error ? error.message : String(error)), 400);
      }
    });

    register(WEB_ROUTES.mcpShare, async (request) => {
      try {
        if (!mcp?.address) return errorReply('MCP sharing is not enabled in plugin configuration', 400);
        const body = await parseBody(request);
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
        const allow = Boolean(body.allow);
        if (!sessionId) return errorReply('sessionId is required', 400);
        mcp.setAllowed(sessionId, allow);
        const allowSessions = mcp.listAllowed();
        updateStoredState((state) => ({ ...state, allowSessions }));
        return jsonReply({ ok: true, value: { allowSessions } });
      } catch (error) {
        return errorReply(error instanceof Error ? error.message : String(error), 400);
      }
    });

    register(WEB_ROUTES.agentSave, async (request) => {
      try {
        const body = await parseBody(request);
        const id = typeof body.id === 'string' ? body.id.trim() : '';
        if (!id) return errorReply('id is required', 400);
        await withAgentRouteLock(id, async () => {
          const existing = manager.getConfig(id);
          const incomingToken = typeof body.token === 'string' ? body.token.trim() : '';
          const clearToken = body.clearToken === true;
          const kind = (body.kind ?? existing?.kind) as AgentConfig['kind'];
          const transport = (body.transport ?? existing?.transport ?? 'direct') as AgentConfig['transport'];
          const sameTransport = existing?.transport === transport;
          const endpointInput = typeof body.endpoint === 'string' ? body.endpoint.trim() : undefined;
          const hostInput =
            endpointInput ??
            (typeof body.host === 'string' ? body.host.trim() : sameTransport ? existing?.host : undefined);
          const resolvedPort =
            body.port !== undefined
              ? body.port === ''
                ? undefined
                : Number(body.port)
              : endpointInput === undefined && sameTransport
                ? existing?.port
                : undefined;
          const resolvedTls =
            typeof body.tls === 'boolean'
              ? body.tls
              : endpointInput === undefined && sameTransport
                ? existing?.tls
                : undefined;
          const resolvedBasePath =
            typeof body.basePath === 'string'
              ? body.basePath.trim() || undefined
              : endpointInput === undefined && sameTransport
                ? existing?.basePath
                : undefined;
          const acpTransport =
            kind === 'acp'
              ? body.acpTransport === 'stdio' || body.acpTransport === 'websocket'
                ? body.acpTransport
                : sameTransport
                  ? existing?.acpTransport
                  : undefined
              : undefined;
          const acpCommand =
            kind === 'acp' && acpTransport === 'stdio'
              ? typeof body.acpCommand === 'string'
                ? body.acpCommand.trim() || undefined
                : sameTransport
                  ? existing?.acpCommand
                  : undefined
              : undefined;
          const candidate: AgentConfig = {
            ...existing,
            id,
            kind,
            transport,
            host: hostInput || undefined,
            port: resolvedPort,
            tls: resolvedTls,
            basePath: resolvedBasePath,
            model: typeof body.model === 'string' ? body.model.trim() || undefined : existing?.model,
            acpTransport,
            acpCommand,
            ...(Array.isArray(body.acpArgs) ? { acpArgs: body.acpArgs.map(String) } : {}),
          };
          for (const key of Object.keys(candidate) as Array<keyof AgentConfig>) {
            if (candidate[key] === undefined) delete candidate[key];
          }
          const normalized = normalizeConfig({ agents: [candidate] }).agents[0]!;
          const sameGateway =
            existing &&
            sameTransport &&
            existing.kind === normalized.kind &&
            existing.host === normalized.host &&
            existing.port === normalized.port &&
            Boolean(existing.tls) === Boolean(normalized.tls) &&
            existing.basePath === normalized.basePath &&
            (existing.acpTransport ?? 'websocket') === (normalized.acpTransport ?? 'websocket');
          if (clearToken || incomingToken || !sameGateway) {
            // An empty token prevents falling back to the previous or ambient gateway credential.
            normalized.token = clearToken ? '' : incomingToken;
            delete normalized.tokenEnv;
          }
          await manager.upsert(normalized, () => {
            updateStoredState((state) => ({
              ...state,
              agents: [...state.agents.filter((item) => item.id !== id), normalized],
              deletedIds: state.deletedIds.filter((item) => item !== id),
            }));
          });
        });
        return jsonReply({ ok: true, value: { agents: manager.list() } });
      } catch (error) {
        return errorReply(error instanceof Error ? error.message : String(error), 400);
      }
    });

    register(WEB_ROUTES.agentDelete, async (request) => {
      try {
        const body = await parseBody(request);
        const id = typeof body.id === 'string' ? body.id.trim() : '';
        if (!id) return errorReply('id is required', 400);
        await withAgentRouteLock(id, async () => {
          await manager.remove(id, () => {
            updateStoredState((state) => ({
              ...state,
              agents: state.agents.filter((item) => item.id !== id),
              deletedIds: [...new Set([...state.deletedIds, id])],
            }));
          });
        });
        return jsonReply({ ok: true, value: { agents: manager.list() } });
      } catch (error) {
        return errorReply(error instanceof Error ? error.message : String(error), 400);
      }
    });
  };

  if (
    typeof (ctx as unknown as { inject?: (deps: string[], cb: (subCtx: Context) => void) => void }).inject ===
    'function'
  ) {
    (ctx as unknown as { inject: (deps: string[], cb: (subCtx: Context) => void) => void }).inject(
      ['connection'],
      (connCtx) => mountAll(connCtx),
    );
  } else {
    mountAll(ctx);
  }
}
