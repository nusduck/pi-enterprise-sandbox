import { randomUUID } from 'node:crypto';
import { Type } from 'typebox';
import { ApprovalSuspendedError } from '../../../../services/approval-waiter.js';

function result(value, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    details: value,
    isError,
  };
}

export function createMcpExtension(options = {}) {
  return function enterpriseMcpExtension(pi) {
    pi.registerTool({
      name: 'mcp',
      label: 'Enterprise MCP',
      description: 'Search, describe, or invoke an allowed external MCP tool. Use search before describe and invoke.',
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal('search'),
          Type.Literal('describe'),
          Type.Literal('invoke'),
        ]),
        query: Type.Optional(Type.String()),
        tool: Type.Optional(Type.String()),
        arguments: Type.Optional(Type.Object({}, { additionalProperties: true })),
      }),
      async execute(toolCallId, input, signal) {
        try {
          if (input.action === 'search') {
            const tools = await options.manager.search(input.query || '', { signal });
            options.emit?.({ type: 'mcp_discovered', query: input.query || '', count: tools.length, ...(options.getMeta?.() || {}) });
            return result({ tools });
          }
          if (!input.tool) return result({ error: 'tool is required' }, true);
          if (input.action === 'describe') {
            const tool = await options.manager.describe(input.tool, { signal });
            return result({
              tool: tool.key,
              description: tool.description,
              input_schema: tool.inputSchema,
              risk_level: tool.riskLevel,
              side_effect: tool.sideEffect,
            });
          }

          const preApproved = options.getPreApprovedIds?.();
          const approved = preApproved instanceof Set && preApproved.size > 0;
          const invoked = await options.manager.invoke(input.tool, input.arguments || {}, { signal, approved });
          if (invoked.status === 'approval_required') {
            const approval = await options.createApproval?.({
              tool_name: `mcp:${invoked.tool.key}`,
              risk_level: invoked.tool.riskLevel || 'high',
              reason: `External MCP side effect: ${invoked.tool.key}`,
              payload: { tool: invoked.tool.key, arguments: input.arguments || {} },
            });
            const pending = {
              approval_id: approval?.approval_id || `approval_${randomUUID()}`,
              tool_name: 'mcp',
              tool_call_id: toolCallId,
              params: input,
              reason: approval?.reason || `External MCP side effect: ${invoked.tool.key}`,
              risk_level: invoked.tool.riskLevel || 'high',
              ...(options.getMeta?.() || {}),
            };
            options.emit?.({ type: 'approval_required', ...pending });
            await options.onApprovalSuspend?.(pending);
            throw new ApprovalSuspendedError(pending);
          }
          if (approved) preApproved.clear();
          options.emit?.({
            type: 'mcp_invoked',
            server: invoked.serverId,
            tool: invoked.tool,
            result_ref: invoked.resultRef,
            timestamp: invoked.timestamp,
            truncated: invoked.truncated,
            ...(options.getMeta?.() || {}),
          });
          return result({
            server: invoked.serverId,
            tool: invoked.tool,
            result: invoked.result,
            result_ref: invoked.resultRef,
            timestamp: invoked.timestamp,
            truncated: invoked.truncated,
          });
        } catch (error) {
          if (error instanceof ApprovalSuspendedError) throw error;
          options.emit?.({ type: 'mcp_failed', tool: input.tool || null, error: error.message, ...(options.getMeta?.() || {}) });
          return result({ error: error.message }, true);
        }
      },
    });
  };
}
