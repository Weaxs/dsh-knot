import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { runDoctor } from './doctor.js';
import type { AgentManager } from './manager.js';
import type { AgentJob } from './types.js';

const output = {
  schema: { type: 'json' as const },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
};

export function registerTools(ctx: Context, manager: AgentManager): void {
  ctx.tools.register(
    defineTool({
      name: 'agent_list',
      description: 'List remote Hermes, OpenClaw, and DSH agents configured through dsh-knot.',
      parameters: { health: { type: 'boolean', description: 'Also probe every agent gateway.' } },
      output,
      async execute(args, exec) {
        const agents = manager.list();
        if (!args.health) return plain({ agents });
        return plain({
          agents: await Promise.all(
            agents.map(async (agent) => {
              try {
                return { ...agent, health: await manager.adapter(agent.id).health(exec.signal) };
              } catch (error) {
                return { ...agent, health: { ok: false, error: message(error) } };
              }
            }),
          ),
        });
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'agent_ask',
      description:
        'Start a task on a remote Hermes, OpenClaw, or DSH agent. Returns a job id immediately; use agent_status to read progress and agent_continue for follow-ups.',
      parameters: {
        agent: { type: 'string', required: true },
        task: { type: 'string', required: true },
        session: { type: 'string', description: 'Optional remote session id to continue.' },
        wait: { type: 'boolean', description: 'Wait for completion before returning.' },
      },
      output,
      async execute(args, exec) {
        const job = manager.start(args.agent, args.task, args.session, (completed) => notifyAgent(exec, completed));
        return plain(modelJob(args.wait ? await manager.wait(job.id, exec.signal) : job));
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'agent_continue',
      description: 'Send a follow-up message to the same remote Hermes, OpenClaw, or DSH session.',
      parameters: {
        agent: { type: 'string', required: true },
        session: { type: 'string', required: true },
        message: { type: 'string', required: true },
        wait: { type: 'boolean' },
      },
      output,
      async execute(args, exec) {
        const job = manager.start(args.agent, args.message, args.session, (completed) => notifyAgent(exec, completed));
        return plain(modelJob(args.wait ? await manager.wait(job.id, exec.signal) : job));
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'agent_status',
      description: 'Read a remote agent job, including streamed text and pending approvals.',
      parameters: {
        job: { type: 'string', required: true },
        wait: { type: 'boolean', description: 'Wait for the job to finish.' },
      },
      output,
      async execute(args, exec) {
        return plain(modelJob(args.wait ? await manager.wait(args.job, exec.signal) : manager.get(args.job)));
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'agent_cancel',
      description: 'Cancel a running task on a remote Hermes, OpenClaw, or DSH agent.',
      parameters: { job: { type: 'string', required: true } },
      output,
      async execute(args, exec) {
        return plain(modelJob(await manager.cancel(args.job, exec.signal)));
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'agent_respond',
      description:
        'Answer a pending approval emitted by a remote agent job. Always requires explicit user confirmation bound to the exact request_id.',
      parameters: {
        job: { type: 'string', required: true },
        request_id: {
          type: 'string',
          required: true,
          description: 'The exact pendingApproval.requestId from agent_status.',
        },
        choice: { type: 'string', required: true, description: 'The exact choice offered by the remote agent.' },
      },
      output,
      async execute(args, exec) {
        return plain(modelJob(await manager.respond(args.job, args.choice, exec.signal, args.request_id)));
      },
    }),
  );

  if (typeof (ctx as unknown as { on?: (...args: unknown[]) => unknown }).on === 'function') {
    ctx.on('tools/pre-execute', async (exec, next) => {
      if (exec.name !== 'agent_respond') return next();
      const decision = await next();
      if (decision.kind === 'deny' || decision.kind === 'cancel') return decision;
      const args = exec.arguments as Record<string, unknown> | undefined;
      const jobId = typeof args?.job === 'string' ? args.job : '';
      const requestId = typeof args?.request_id === 'string' ? args.request_id : '';
      const choice = typeof args?.choice === 'string' ? args.choice : '';
      let promptDetail = '';
      try {
        const pending = manager.get(jobId).pendingApproval;
        if (pending && pending.requestId === requestId && pending.text) {
          promptDetail = `: ${pending.text}`;
        }
      } catch {
        /* let execute surface unknown job/request errors if approved */
      }
      return {
        kind: 'ask',
        reason: `Remote agent approval requires explicit user confirmation (job ${jobId}, request ${requestId}, choice "${choice}"${promptDetail}).`,
        displayReason: {
          en: `Allow sending "${choice}" to remote approval ${requestId} on job ${jobId}${promptDetail}?`,
          'zh-CN': `确认向远端任务 ${jobId} 的审批请求 ${requestId} 提交「${choice}」${promptDetail}吗？`,
        },
      };
    });
  }

  ctx.tools.register(
    defineTool({
      name: 'knot_doctor',
      description: 'Check gateway reachability and protocol health for configured agents.',
      parameters: { agent: { type: 'string', description: 'Check one agent id; omit to check all.' } },
      output,
      async execute(args, exec) {
        return plain(await runDoctor(manager, args.agent, exec.signal));
      },
    }),
  );
}

function plain(value: unknown): any {
  return JSON.parse(JSON.stringify(value));
}

function modelJob({
  thought: _thought,
  timeline: _timeline,
  historyBaseline: _historyBaseline,
  tools,
  ...job
}: AgentJob): AgentJob {
  return { ...job, ...(tools ? { tools: tools.map(({ id, name, status }) => ({ id, name, status })) } : {}) };
}

function notifyAgent(exec: { agent?: unknown }, job: AgentJob): void {
  const agent = exec.agent as { followup?: (message: unknown) => void } | undefined;
  if (!agent?.followup) return;
  agent.followup({
    role: 'user',
    content: [{ type: 'text', text: `Remote agent job update:\n${JSON.stringify(modelJob(job))}` }],
    source: { kind: 'knot' },
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
