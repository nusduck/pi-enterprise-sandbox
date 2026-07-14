import { Type } from 'typebox';

const STATUS = new Set(['pending', 'in_progress', 'completed', 'blocked']);

function textResult(payload, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    details: payload,
    isError,
  };
}

export function createTaskPlanExtension(options = {}) {
  const tasks = new Map();

  return function taskPlanExtension(pi) {
    pi.on('session_start', (_event, ctx) => {
      const entries = ctx.sessionManager?.getEntries?.() || [];
      const last = [...entries]
        .reverse()
        .find((entry) => entry.type === 'custom' && entry.customType === 'enterprise_task_plan');
      for (const task of last?.data?.tasks || []) {
        if (task?.task_id) tasks.set(task.task_id, task);
      }
    });
    pi.registerTool({
      name: 'task_plan',
      label: 'Task plan',
      description: 'Create and update durable task plan items with status and evidence.',
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal('create'),
          Type.Literal('add'),
          Type.Literal('update'),
          Type.Literal('complete'),
          Type.Literal('block'),
          Type.Literal('list'),
        ]),
        task_id: Type.Optional(Type.String()),
        content: Type.Optional(Type.String()),
        status: Type.Optional(Type.Union([
          Type.Literal('pending'),
          Type.Literal('in_progress'),
          Type.Literal('completed'),
          Type.Literal('blocked'),
        ])),
        evidence: Type.Optional(Type.String()),
      }),
      async execute(_toolCallId, input) {
        if (input.action !== 'list') {
          if (!input.task_id) return textResult({ error: 'task_id is required' }, true);
          const prior = tasks.get(input.task_id) || null;
          if (input.action === 'add' || input.action === 'create') {
            if (!input.content) return textResult({ error: 'content is required' }, true);
            if (prior) return textResult({ error: `task already exists: ${input.task_id}` }, true);
          } else if (!prior) {
            return textResult({ error: `unknown task: ${input.task_id}` }, true);
          }
          const implied = input.action === 'complete'
            ? 'completed'
            : input.action === 'block'
              ? 'blocked'
              : input.status;
          const status = implied || prior?.status || 'pending';
          if (!STATUS.has(status)) return textResult({ error: `invalid status: ${status}` }, true);
          tasks.set(input.task_id, {
            task_id: input.task_id,
            content: input.content || prior?.content,
            status,
            evidence: input.evidence ?? prior?.evidence ?? null,
            updated_at: new Date().toISOString(),
          });
        }

        const projection = { tasks: [...tasks.values()] };
        pi.appendEntry('enterprise_task_plan', projection);
        await options.project?.(projection);
        options.emit?.({ type: 'task_plan_updated', ...projection, ...(options.getMeta?.() || {}) });
        return textResult(projection);
      },
    });
    pi.registerCommand?.('task-plan', {
      description: 'Publish the current durable task plan to the Web runtime.',
      handler: async (_args, ctx) => {
        const projection = { tasks: [...tasks.values()] };
        options.emit?.({ type: 'task_plan_updated', ...projection, ...(options.getMeta?.() || {}) });
        ctx.ui.notify(`${projection.tasks.length} task plan item(s)`, 'info');
      },
    });
  };
}
