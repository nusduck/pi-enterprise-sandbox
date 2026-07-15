import { createHash, randomUUID } from 'node:crypto';
import { Type } from 'typebox';
import { ApprovalSuspendedError } from '../../../../services/approval-waiter.js';
import { APPROVAL_MODE, normalizeApprovalMode } from '../policy/index.js';

function result(value, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    details: value,
    isError,
  };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function stableSerialize(value) {
  return JSON.stringify(canonicalize(value));
}

function operationFingerprint(toolName, args) {
  return createHash('sha256')
    .update(stableSerialize({ tool_name: toolName, params: args || {} }))
    .digest('hex');
}

export function createMcpExtension(options = {}) {
  const approvalMode = normalizeApprovalMode(options.approvalMode || APPROVAL_MODE.ASK);

  function approvalIdempotencyKey(toolName, args, toolCallId) {
    const meta = options.getMeta?.() || {};
    const basis = stableSerialize({
      session_id: meta.session_id || null,
      run_id: meta.run_id || null,
      tool_name: toolName,
      tool_call_id: toolCallId || randomUUID(),
      arguments: args || {},
    });
    return `approval_${createHash('sha256').update(basis).digest('hex').slice(0, 32)}`;
  }

  function matchesPreApprovedAttempt(attempt, toolName, args) {
    const meta = options.getMeta?.() || {};
    return Boolean(
      attempt?.idempotency_key &&
        attempt.tool_name === toolName &&
        attempt.operation_fingerprint === operationFingerprint(toolName, args) &&
        (!attempt.sandbox_session_id || attempt.sandbox_session_id === meta.session_id) &&
        (!attempt.run_id || attempt.run_id === (meta.run_id || null)),
    );
  }

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
        let claimedPreApprovedAttempt = null;
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

          const args = input.arguments || {};
          const preApprovedAttempt = options.getPreApprovedAttempt?.();
          const mcpToolName = `mcp:${input.tool}`;
          const matchesPreApprovedAttemptForCall =
            approvalMode === APPROVAL_MODE.ASK &&
            matchesPreApprovedAttempt(preApprovedAttempt, mcpToolName, args);
          claimedPreApprovedAttempt = matchesPreApprovedAttemptForCall
            ? (options.claimPreApprovedAttempt?.() || preApprovedAttempt)
            : null;
          if (
            matchesPreApprovedAttemptForCall &&
            claimedPreApprovedAttempt !== preApprovedAttempt
          ) {
            return result({
              error: 'Approval resume authorization is already in use',
            }, true);
          }
          const usePreApprovedAttempt = Boolean(
            preApprovedAttempt && claimedPreApprovedAttempt === preApprovedAttempt,
          );
          const approved =
            approvalMode === APPROVAL_MODE.AUTO_APPROVE || usePreApprovedAttempt;
          const invoked = await options.manager.invoke(input.tool, args, { signal, approved });
          if (invoked.status === 'approval_required') {
            if (approvalMode === APPROVAL_MODE.DENY) {
              return result({
                error: 'Approval asking is disabled (APPROVAL_MODE=deny)',
              }, true);
            }
            if (usePreApprovedAttempt) {
              options.releasePreApprovedAttempt?.(claimedPreApprovedAttempt);
              claimedPreApprovedAttempt = null;
              return result({
                error: 'Approved resume operation could not be authorized',
              }, true);
            }
            const invokedToolName = `mcp:${invoked.tool.key}`;
            const approvalOperationFingerprint = operationFingerprint(invokedToolName, args);
            const approvalKey = approvalIdempotencyKey(invokedToolName, args, toolCallId);
            const approval = await options.createApproval?.({
              tool_name: invokedToolName,
              risk_level: invoked.tool.riskLevel || 'high',
              reason: `External MCP side effect: ${invoked.tool.key}`,
              payload: { tool: invoked.tool.key, arguments: args },
              idempotency_key: approvalKey,
              operation_fingerprint: approvalOperationFingerprint,
            });
            const pending = {
              approval_id: approval?.approval_id || `approval_${randomUUID()}`,
              tool_name: invokedToolName,
              tool_call_id: toolCallId,
              params: input,
              reason: approval?.reason || `External MCP side effect: ${invoked.tool.key}`,
              risk_level: invoked.tool.riskLevel || 'high',
              idempotency_key: approval?.idempotency_key || approvalKey,
              operation_fingerprint: approvalOperationFingerprint,
              ...(options.getMeta?.() || {}),
            };
            options.emit?.({ type: 'approval_required', ...pending });
            await options.onApprovalSuspend?.(pending);
            throw new ApprovalSuspendedError(pending);
          }
          if (usePreApprovedAttempt) options.consumePreApprovedAttempt?.();
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
          if (claimedPreApprovedAttempt) {
            options.releasePreApprovedAttempt?.(claimedPreApprovedAttempt);
            claimedPreApprovedAttempt = null;
          }
          options.emit?.({ type: 'mcp_failed', tool: input.tool || null, error: error.message, ...(options.getMeta?.() || {}) });
          return result({ error: error.message }, true);
        }
      },
    });
  };
}
