import { createHash, randomUUID } from 'node:crypto';
import { Type } from 'typebox';
import {
  ApprovalSuspendedError,
  createApprovalPendingToolResult,
} from '../../../../services/approval-waiter.js';
import { APPROVAL_MODE, normalizeApprovalMode } from '../policy/index.js';

function result(value, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
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

/** SDK tool names: [a-z0-9_]+ */
export function toRegisteredMcpToolName(toolKey) {
  const raw = String(toolKey || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
  if (!raw) return null;
  const name = raw.startsWith('mcp_') ? raw : `mcp_${raw}`;
  return name.slice(0, 64);
}

/**
 * Enterprise MCP Extension.
 *
 * - Registers a meta-tool `mcp` (search/describe/invoke)
 * - On `session_start`, discovers allowed remote tools and injects each as a
 *   first-class tool via `pi.registerTool` (pi-extension dynamic-tools pattern)
 * - Durable approval for side-effecting invokes (suspend + resume), not mid-turn UI confirm
 */
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

  async function invokeRemote(toolCallId, toolKey, args, signal) {
    let claimedPreApprovedAttempt = null;
    const preApprovedAttempt = options.getPreApprovedAttempt?.();
    const mcpToolName = `mcp:${toolKey}`;
    const matchesPreApprovedAttemptForCall =
      approvalMode === APPROVAL_MODE.ASK &&
      matchesPreApprovedAttempt(preApprovedAttempt, mcpToolName, args);
    claimedPreApprovedAttempt = matchesPreApprovedAttemptForCall
      ? options.claimPreApprovedAttempt?.() || preApprovedAttempt
      : null;
    if (
      matchesPreApprovedAttemptForCall &&
      claimedPreApprovedAttempt !== preApprovedAttempt
    ) {
      return result({ error: 'Approval resume authorization is already in use' }, true);
    }
    const usePreApprovedAttempt = Boolean(
      preApprovedAttempt && claimedPreApprovedAttempt === preApprovedAttempt,
    );
    const approved =
      approvalMode === APPROVAL_MODE.AUTO_APPROVE || usePreApprovedAttempt;
    try {
      const invoked = await options.manager.invoke(toolKey, args || {}, {
        signal,
        approved,
      });
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
        const invokedToolName = `mcp:${invoked.tool.key || toolKey}`;
        const approvalOperationFingerprint = operationFingerprint(
          invokedToolName,
          args || {},
        );
        const approvalKey = approvalIdempotencyKey(
          invokedToolName,
          args || {},
          toolCallId,
        );
        const approval = await options.createApproval?.({
          tool_name: invokedToolName,
          risk_level: invoked.tool.riskLevel || 'high',
          reason: `External MCP side effect: ${invoked.tool.key || toolKey}`,
          payload: { tool: invoked.tool.key || toolKey, arguments: args || {} },
          idempotency_key: approvalKey,
          operation_fingerprint: approvalOperationFingerprint,
        });
        const pending = {
          approval_id: approval?.approval_id || `approval_${randomUUID()}`,
          tool_name: invokedToolName,
          tool_call_id: toolCallId,
          params: { tool: toolKey, arguments: args || {} },
          reason:
            approval?.reason ||
            `External MCP side effect: ${invoked.tool.key || toolKey}`,
          risk_level: invoked.tool.riskLevel || 'high',
          idempotency_key: approval?.idempotency_key || approvalKey,
          operation_fingerprint: approvalOperationFingerprint,
          ...(options.getMeta?.() || {}),
        };
        // Single emission point — run-manager only updates status, does not re-emit.
        options.emit?.({ type: 'approval_required', ...pending });
        await options.onApprovalSuspend?.(pending);
        // Terminate placeholder — do not throw ApprovalSuspendedError (that becomes
        // a durable error toolResult and confuses the model after resume).
        return createApprovalPendingToolResult(pending);
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
      if (error instanceof ApprovalSuspendedError || error?.name === 'ApprovalSuspendedError') {
        return createApprovalPendingToolResult(error.pending);
      }
      if (claimedPreApprovedAttempt) {
        options.releasePreApprovedAttempt?.(claimedPreApprovedAttempt);
      }
      options.emit?.({
        type: 'mcp_failed',
        tool: toolKey || null,
        error: error.message,
        ...(options.getMeta?.() || {}),
      });
      return result({ error: error.message }, true);
    }
  }

  return function enterpriseMcpExtension(pi) {
    const registeredRemote = new Map(); // registeredName -> tool.key

    pi.registerTool({
      name: 'mcp',
      label: 'Enterprise MCP',
      description:
        'Search, describe, or invoke an allowed external MCP tool. Prefer first-class mcp_* tools injected at session start when available. Use action=search with an empty query to list all tools.',
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
            options.emit?.({
              type: 'mcp_discovered',
              query: input.query || '',
              count: tools.length,
              ...(options.getMeta?.() || {}),
            });
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
          return invokeRemote(toolCallId, input.tool, input.arguments || {}, signal);
        } catch (error) {
          if (error instanceof ApprovalSuspendedError || error?.name === 'ApprovalSuspendedError') {
            return createApprovalPendingToolResult(error.pending);
          }
          options.emit?.({
            type: 'mcp_failed',
            tool: input?.tool || null,
            error: error.message,
            ...(options.getMeta?.() || {}),
          });
          return result({ error: error.message }, true);
        }
      },
    });

    /**
     * Inject discovered MCP tools as first-class tools (pi dynamic-tools pattern).
     * Runs on session_start so the model sees them in the tool list without search.
     */
    async function injectDiscoveredTools(reason = 'session_start') {
      if (!options.manager || typeof options.manager.discover !== 'function') {
        return [];
      }
      let tools = [];
      try {
        tools = await options.manager.discover({ refresh: true });
      } catch (error) {
        options.emit?.({
          type: 'mcp_discover_failed',
          reason,
          error: error?.message || String(error),
          ...(options.getMeta?.() || {}),
        });
        return [];
      }

      const injected = [];
      for (const tool of tools) {
        const registeredName = toRegisteredMcpToolName(tool.key);
        if (!registeredName || registeredRemote.has(registeredName)) continue;
        registeredRemote.set(registeredName, tool.key);
        const description = [
          tool.description || `Remote MCP tool ${tool.key}`,
          `Remote key: ${tool.key}.`,
          tool.sideEffect || tool.riskLevel === 'high'
            ? 'May have side effects; high-risk calls require approval.'
            : 'Read-oriented remote capability.',
        ].join(' ');
        pi.registerTool({
          name: registeredName,
          label: tool.name || registeredName,
          description,
          promptSnippet: `MCP ${tool.key}: ${(tool.description || '').slice(0, 120)}`,
          parameters: Type.Object({}, { additionalProperties: true }),
          async execute(toolCallId, params, signal) {
            return invokeRemote(toolCallId, tool.key, params || {}, signal);
          },
        });
        injected.push({
          registered_name: registeredName,
          tool: tool.key,
          risk_level: tool.riskLevel,
          side_effect: tool.sideEffect,
          description: (tool.description || '').slice(0, 240),
        });
      }

      options.emit?.({
        type: 'mcp_discovered',
        query: '',
        reason,
        count: injected.length,
        tools: injected,
        ...(options.getMeta?.() || {}),
      });
      return injected;
    }

    pi.on('session_start', async () => {
      await injectDiscoveredTools('session_start');
    });
  };
}
