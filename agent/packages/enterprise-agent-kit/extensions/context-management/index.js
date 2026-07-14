import { Type } from 'typebox';
import { filterToolResultContent } from '../policy/index.js';

export const ENTERPRISE_COMPACTION_INSTRUCTIONS = `
Use this exact summary structure and preserve concrete evidence:

## User Goal
## Constraints
## Completed Work
## Current Plan
## Pending Tasks
## Blockers
## Key Decisions
## Files Read
## Files Modified
## Tests and Evidence
## MCP Results Used
## Required Next Action

For MCP results retain only server, tool, key arguments, conclusion, result reference ID, and timestamp.
`.trim();

function contextPayload(ctx) {
  const usage = ctx.getContextUsage?.();
  if (!usage) return null;
  return {
    tokens: usage.tokens,
    context_window: usage.contextWindow,
    percent: usage.percent,
  };
}

function messageText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text')
    .map((part) => String(part.text || ''))
    .join('\n');
}

function summarySection(summary, title) {
  if (!summary) return '';
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(summary)
    .match(new RegExp(`## ${escaped}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`))?.[1]
    ?.trim() || '';
}

function structuredCompaction(event) {
  const messages = event.preparation?.messagesToSummarize || [];
  const users = messages.filter((message) => message.role === 'user').map(messageText).filter(Boolean);
  const assistants = messages.filter((message) => message.role === 'assistant').map(messageText).filter(Boolean);
  const planEntry = [...(event.branchEntries || [])]
    .reverse()
    .find((entry) => entry.type === 'custom' && entry.customType === 'enterprise_task_plan');
  const tasks = planEntry?.data?.tasks || [];
  const pending = tasks.filter((task) => task.status !== 'completed');
  const completed = tasks.filter((task) => task.status === 'completed');
  const files = event.preparation?.fileOps || {};
  const previous = event.preparation?.previousSummary || '';
  const modifiedFiles = [
    ...(files.written || []),
    ...(files.edited || []),
  ];
  const modifiedSet = new Set(modifiedFiles);
  const readFiles = [...(files.read || [])].filter((file) => !modifiedSet.has(file));
  const lines = [
    '## User Goal', summarySection(previous, 'User Goal') || users[0] || 'Continue the active conversation goal.',
    '## Constraints', summarySection(previous, 'Constraints') || 'Preserve enterprise Sandbox, MCP, policy, and Agent Profile boundaries.',
    '## Completed Work', [
      summarySection(previous, 'Completed Work'),
      completed.map((task) => `- ${task.content}${task.evidence ? ` — ${task.evidence}` : ''}`).join('\n'),
    ].filter(Boolean).join('\n') || assistants.slice(-3).join('\n\n') || 'None recorded.',
    '## Current Plan', tasks.map((task) => `- [${task.status}] ${task.task_id}: ${task.content}`).join('\n') || 'No structured plan recorded.',
    '## Pending Tasks', pending.map((task) => `- ${task.task_id}: ${task.content}`).join('\n') || 'None recorded.',
    '## Blockers', tasks.filter((task) => task.status === 'blocked').map((task) => `- ${task.content}`).join('\n') || 'None recorded.',
    '## Key Decisions', summarySection(previous, 'Key Decisions') || 'See retained recent context and session custom entries.',
    '## Files Read', [summarySection(previous, 'Files Read'), readFiles.map((file) => `- ${file}`).join('\n')].filter(Boolean).join('\n') || 'None recorded.',
    '## Files Modified', [summarySection(previous, 'Files Modified'), [...modifiedSet].map((file) => `- ${file}`).join('\n')].filter(Boolean).join('\n') || 'None recorded.',
    '## Tests and Evidence', [summarySection(previous, 'Tests and Evidence'), completed.filter((task) => task.evidence).map((task) => `- ${task.evidence}`).join('\n')].filter(Boolean).join('\n') || 'None recorded.',
    '## MCP Results Used', summarySection(previous, 'MCP Results Used') || 'Retained only through task evidence or recent context; credentials and raw oversized payloads omitted.',
    '## Required Next Action', pending[0]?.content || users.at(-1) || 'Continue from retained recent context.',
  ];
  return {
    summary: lines.join('\n\n'),
    firstKeptEntryId: event.preparation.firstKeptEntryId,
    tokensBefore: event.preparation.tokensBefore,
    details: {
      readFiles,
      modifiedFiles: [...modifiedSet],
      enterpriseStructured: true,
    },
  };
}

export function transformContextMessages(messages, maxToolResultChars = 32_000) {
  return (messages || []).map((message) => {
    if (message?.role !== 'toolResult' || !Array.isArray(message.content)) return message;
    const filtered = filterToolResultContent(message.content, maxToolResultChars);
    return filtered.changed ? { ...message, content: filtered.content } : message;
  });
}

export function createContextManagementExtension(options = {}) {
  const threshold = options.policy?.warningThreshold ?? 0.8;
  return function contextManagementExtension(pi) {
    const inspect = (_event, ctx) => {
      const usage = contextPayload(ctx);
      if (!usage) return;
      options.emit?.({ type: 'context_stats', ...usage, ...(options.getMeta?.() || {}) });
      const ratio = usage.percent == null ? null : usage.percent > 1 ? usage.percent / 100 : usage.percent;
      if (ratio != null && ratio >= threshold) {
        options.emit?.({
          type: 'context_warning',
          threshold,
          ...usage,
          ...(options.getMeta?.() || {}),
        });
      }
    };
    pi.on('turn_start', inspect);
    pi.on('context', (event) => ({
      messages: transformContextMessages(event.messages),
    }));
    pi.on('session_before_compact', (event) => ({
      compaction: structuredCompaction(event),
    }));
    pi.registerCommand?.('context-stats', {
      description: 'Show current context utilization.',
      handler: async (_args, ctx) => {
        const usage = contextPayload(ctx);
        options.emit?.({ type: 'context_stats', ...(usage || {}), ...(options.getMeta?.() || {}) });
        ctx.ui.notify(usage ? JSON.stringify(usage) : 'Context usage is unavailable', 'info');
      },
    });
    pi.registerCommand?.('compact-enterprise', {
      description: 'Compact with the enterprise retention template.',
      handler: async (_args, ctx) => {
        ctx.compact({ customInstructions: ENTERPRISE_COMPACTION_INSTRUCTIONS });
      },
    });
    pi.registerTool({
      name: 'context_compact',
      label: 'Compact context',
      description: 'Request enterprise-structured context compaction and report current usage.',
      parameters: Type.Object({ reason: Type.Optional(Type.String()) }),
      async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
        const before = contextPayload(ctx);
        ctx.compact({ customInstructions: ENTERPRISE_COMPACTION_INSTRUCTIONS });
        return {
          content: [{ type: 'text', text: 'Context compaction requested.' }],
          details: { requested: true, reason: input.reason || 'manual', before },
        };
      },
    });
  };
}
