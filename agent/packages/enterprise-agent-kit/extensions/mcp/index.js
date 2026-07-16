import { createHash, randomUUID } from 'node:crypto';
import { Type } from 'typebox';
import {
  ApprovalSuspendedError,
  createApprovalPendingToolResult,
} from '../../../../services/approval-waiter.js';
import { sanitizeUntrustedText } from '../../../../lib/text-redaction.js';
import { APPROVAL_MODE, normalizeApprovalMode } from '../policy/index.js';

const MAX_MCP_TEXT = 240;
const MAX_MCP_EMIT_TOOLS = 20;
const MAX_QUERY_LEN = 128;
const MAX_MCP_TOOL_ID = 128;
const REGISTERED_NAME_MAX = 64;

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

const REGISTERED_HASH_LEN = 8;

function sanitizedRegisteredStem(toolKey) {
  const raw = String(toolKey || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
  if (!raw) return null;
  return raw.startsWith('mcp_') ? raw : `mcp_${raw}`;
}

function registeredNameSuffix(toolKey) {
  return createHash('sha256').update(String(toolKey)).digest('hex').slice(0, REGISTERED_HASH_LEN);
}

/**
 * Deterministic SDK tool name from the full remote tool key.
 * Bounded stem + stable key hash suffix — independent of discovery peers/history.
 * @param {string} toolKey
 */
export function toRegisteredMcpToolName(toolKey) {
  const stem = sanitizedRegisteredStem(toolKey);
  if (!stem) return null;
  const suffix = registeredNameSuffix(toolKey);
  const tag = `_${suffix}`;
  const stemMax = REGISTERED_NAME_MAX - tag.length;
  if (stemMax < 4) return `mcp_${suffix}`.slice(0, REGISTERED_NAME_MAX);
  return `${stem.slice(0, stemMax)}${tag}`;
}

/**
 * Map tool keys to registered names (pure function of each key).
 * @param {Array<{ key?: string }>} tools
 */
export function buildRegisteredMcpToolNameMap(tools = []) {
  const map = new Map();
  for (const tool of Array.isArray(tools) ? tools : []) {
    const key = tool?.key;
    if (!key || map.has(key)) continue;
    const name = toRegisteredMcpToolName(key);
    if (name) map.set(key, name);
  }
  return map;
}

function safeMcpText(value, max = MAX_MCP_TEXT) {
  return sanitizeUntrustedText(value, max) || '';
}

function safeMcpToolId(value) {
  if (value == null) return null;
  if (typeof value === 'object') {
    const key = value.key || value.tool;
    return safeMcpText(key, MAX_MCP_TOOL_ID) || null;
  }
  return safeMcpText(value, MAX_MCP_TOOL_ID) || null;
}

function mcpError(messageOrValue, isError = true) {
  const payload =
    typeof messageOrValue === 'string'
      ? { error: safeMcpText(messageOrValue, MAX_MCP_TEXT) }
      : {
          ...messageOrValue,
          error: safeMcpText(messageOrValue?.error || 'MCP operation failed', MAX_MCP_TEXT),
        };
  return result(payload, isError);
}

function boundMcpToolSummaries(tools = []) {
  return (Array.isArray(tools) ? tools : []).slice(0, MAX_MCP_EMIT_TOOLS).map((tool) => ({
    tool: safeMcpToolId(tool.tool || tool.key),
    name: tool.name,
    description: safeMcpText(tool.description, MAX_MCP_TEXT),
    risk_level: tool.riskLevel || tool.risk_level,
    side_effect: tool.sideEffect ?? tool.side_effect,
    score: tool.score,
    matched: tool.matched,
    note: tool.note ? safeMcpText(tool.note, MAX_MCP_TEXT) : undefined,
  }));
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
      return mcpError('Approval resume authorization is already in use');
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
          return mcpError('Approval asking is disabled (APPROVAL_MODE=deny)');
        }
        if (usePreApprovedAttempt) {
          options.releasePreApprovedAttempt?.(claimedPreApprovedAttempt);
          claimedPreApprovedAttempt = null;
          return mcpError('Approved resume operation could not be authorized');
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
        tool: safeMcpToolId(invoked.tool?.key || invoked.tool || toolKey),
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
        tool: safeMcpToolId(toolKey),
        error: safeMcpText(error.message, MAX_MCP_TEXT),
        ...(options.getMeta?.() || {}),
      });
      return mcpError(error.message);
    }
  }

  return function enterpriseMcpExtension(pi) {
    const registeredRemote = new Map(); // registeredName -> tool.key
    const ownedMcpRegisteredNames = new Set();

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
            const query = safeMcpText(input.query || '', MAX_QUERY_LEN);
            const tools = await options.manager.search(query, { signal });
            const bounded = boundMcpToolSummaries(tools);
            options.emit?.({
              type: 'mcp_discovered',
              query,
              count: tools.length,
              returned: bounded.length,
              tools: bounded,
              ...(options.getMeta?.() || {}),
            });
            return result({ tools: bounded, total: tools.length, returned: bounded.length });
          }
          if (!input.tool) return mcpError('tool is required');
          if (input.action === 'describe') {
            const tool = await options.manager.describe(input.tool, { signal });
            return result({
              tool: tool.key,
              description: safeMcpText(tool.description, MAX_MCP_TEXT),
              risk_level: tool.riskLevel,
              side_effect: tool.sideEffect,
              note: 'Full input schema is not exposed; invoke with validated arguments only.',
            });
          }
          return invokeRemote(toolCallId, input.tool, input.arguments || {}, signal);
        } catch (error) {
          if (error instanceof ApprovalSuspendedError || error?.name === 'ApprovalSuspendedError') {
            return createApprovalPendingToolResult(error.pending);
          }
      options.emit?.({
        type: 'mcp_failed',
        tool: safeMcpToolId(input?.tool),
        error: safeMcpText(error.message, MAX_MCP_TEXT),
        ...(options.getMeta?.() || {}),
      });
          return mcpError(error.message);
        }
      },
    });

    /**
     * Inject discovered MCP tools as first-class tools (pi dynamic-tools pattern).
     * Runs on session_start so the model sees them in the tool list without search.
     */
    function getRegistry() {
      if (typeof options.getCapabilityRegistry === 'function') {
        return options.getCapabilityRegistry();
      }
      return options.capabilityRegistry || null;
    }

    /**
     * Configured + allowed MCP server IDs for this session.
     * Never invent a synthetic "mcp" server name.
     */
    function resolveConfiguredServers() {
      if (Array.isArray(options.configuredMcpServers) && options.configuredMcpServers.length) {
        return options.configuredMcpServers.map((entry) => ({
          id: String(entry.id),
          enabled: entry.enabled !== false,
        }));
      }
      if (Array.isArray(options.configuredServerIds) && options.configuredServerIds.length) {
        return options.configuredServerIds.map((id) => ({ id: String(id), enabled: true }));
      }
      const manager = options.manager;
      if (!manager?.servers || typeof manager.servers.values !== 'function') {
        return [];
      }
      const servers = [];
      for (const server of manager.servers.values()) {
        if (!server?.id) continue;
        if (typeof manager.isServerAllowed === 'function' && !manager.isServerAllowed(server.id)) {
          continue;
        }
        servers.push({ id: String(server.id), enabled: server.enabled !== false });
      }
      return servers;
    }

    function reconcileMcpTools(tools, reason, serverStatuses = []) {
      const registry = getRegistry();
      if (!registry) return;
      const configured = resolveConfiguredServers();
      const statusById = new Map(
        (Array.isArray(serverStatuses) ? serverStatuses : []).map((row) => [
          row.serverId,
          row,
        ]),
      );
      const registeredNames = buildRegisteredMcpToolNameMap(tools || []);
      const mcpToolEntries = (tools || []).map((tool) => {
        const registeredName =
          registeredNames.get(tool.key) || toRegisteredMcpToolName(tool.key);
        return {
          kind: 'mcp_tool',
          name: registeredName || tool.key,
          status: 'active',
          source: `mcp:${tool.serverId}`,
          description: safeMcpText(tool.description, MAX_MCP_TEXT),
          dynamic: true,
          metadata: {
            server_id: tool.serverId,
            tool_key: tool.key,
            registered_name: registeredName || undefined,
            risk_level: tool.riskLevel || undefined,
            side_effect: Boolean(tool.sideEffect),
          },
        };
      });
      registry.reconcile('mcp_tool', mcpToolEntries, 'mcp_discovery', reason);

      const serverEntries = configured.map(({ id, enabled }) => {
        const statusInfo = statusById.get(id);
        const toolCount = (tools || []).filter((t) => t.serverId === id).length;
        if (enabled === false) {
          return {
            kind: 'mcp_server',
            name: id,
            status: 'disabled',
            source: 'mcp-connection-manager',
            description: `MCP server ${id} (disabled in configuration)`,
            dynamic: true,
            metadata: {
              server_id: id,
              connection_status: 'disabled',
              tool_count: 0,
              reason: 'server_disabled',
            },
          };
        }
        if (statusInfo?.status === 'failed') {
          return {
            kind: 'mcp_server',
            name: id,
            status: 'failed',
            source: 'mcp-connection-manager',
            description: `MCP server ${id} discovery failed`,
            dynamic: true,
            metadata: {
              server_id: id,
              connection_status: 'error',
              tool_count: 0,
              error: safeMcpText(statusInfo.error, MAX_MCP_TEXT),
            },
          };
        }
        return {
          kind: 'mcp_server',
          name: id,
          status: 'active',
          source: 'mcp-connection-manager',
          description: `MCP server ${id}`,
          dynamic: true,
          metadata: {
            server_id: id,
            connection_status: 'connected',
            tool_count: toolCount,
          },
        };
      });
      registry.reconcile('mcp_server', serverEntries, 'mcp_discovery', reason);
    }

    function syncActiveMcpTools(currentMcpNames) {
      if (
        typeof pi.getActiveTools !== 'function' ||
        typeof pi.setActiveTools !== 'function'
      ) {
        return;
      }
      const active = pi.getActiveTools() || [];
      const nonMcpActive = active.filter((name) => !ownedMcpRegisteredNames.has(name));
      const seen = new Set();
      const nextActive = [];
      for (const name of [...nonMcpActive, ...currentMcpNames]) {
        if (!name || seen.has(name)) continue;
        seen.add(name);
        nextActive.push(name);
      }
      pi.setActiveTools(nextActive);
    }

    async function injectDiscoveredTools(reason = 'session_start') {
      if (
        !options.manager ||
        typeof options.manager.discoverDetailed !== 'function'
      ) {
        return [];
      }
      const configured = resolveConfiguredServers();
      let tools = [];
      let serverStatuses = [];
      try {
        const detailed = await options.manager.discoverDetailed({
          refresh: true,
          serverIds: configured.map((s) => s.id),
        });
        tools = detailed.tools || [];
        serverStatuses = detailed.servers || [];
      } catch (error) {
        const message = safeMcpText(error?.message || String(error), MAX_MCP_TEXT);
        options.emit?.({
          type: 'mcp_discover_failed',
          reason,
          error: message,
          ...(options.getMeta?.() || {}),
        });
        reconcileMcpTools([], reason, configured.map((s) => ({
          serverId: s.id,
          status: s.enabled === false ? 'disabled' : 'failed',
          toolCount: 0,
          error: s.enabled === false ? null : message,
          disabled: s.enabled === false,
        })));
        syncActiveMcpTools([]);
        return [];
      }

      const registeredNames = buildRegisteredMcpToolNameMap(tools);
      const currentMcpNames = [];
      const injected = [];
      for (const tool of tools) {
        const registeredName =
          registeredNames.get(tool.key) || toRegisteredMcpToolName(tool.key);
        if (!registeredName) continue;
        ownedMcpRegisteredNames.add(registeredName);
        currentMcpNames.push(registeredName);
        if (registeredRemote.has(registeredName)) continue;
        registeredRemote.set(registeredName, tool.key);
        const safeDescription = safeMcpText(tool.description, MAX_MCP_TEXT);
        const description = safeMcpText(
          [
            safeDescription || `Remote MCP tool ${tool.key}`,
            `Remote key: ${tool.key}.`,
            tool.sideEffect || tool.riskLevel === 'high'
              ? 'May have side effects; high-risk calls require approval.'
              : 'Read-oriented remote capability.',
          ].join(' '),
          480,
        );
        pi.registerTool({
          name: registeredName,
          label: tool.name || registeredName,
          description,
          promptSnippet: safeMcpText(`MCP ${tool.key}: ${tool.description || ''}`, 120),
          parameters: Type.Object({}, { additionalProperties: true }),
          async execute(toolCallId, params, signal) {
            return invokeRemote(toolCallId, tool.key, params || {}, signal);
          },
        });
        injected.push({
          registered_name: registeredName,
          tool: safeMcpToolId(tool.key),
          risk_level: tool.riskLevel,
          side_effect: tool.sideEffect,
          description: safeMcpText(tool.description, MAX_MCP_TEXT),
        });
      }

      syncActiveMcpTools(currentMcpNames);
      reconcileMcpTools(tools, reason, serverStatuses);

      const boundedInjected = injected.slice(0, MAX_MCP_EMIT_TOOLS);
      options.emit?.({
        type: 'mcp_discovered',
        query: '',
        reason,
        count: injected.length,
        returned: boundedInjected.length,
        tools: boundedInjected,
        ...(options.getMeta?.() || {}),
      });
      return injected;
    }

    pi.on('session_start', async () => {
      await injectDiscoveredTools('session_start');
    });
  };
}
