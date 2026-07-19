/**
 * Layered policy engine (plan §14.1).
 *
 * Platform > Organization > AgentVersion > Tool > Request context
 * Lower layers cannot relax higher layers.
 *
 * Every decision is audited via auditSink. If audit fails, allow is fail-closed.
 */

import { redactPayload } from '../../infrastructure/pi/platform-event-projector.js';
import { evaluateLocalArgGuards } from './arg-guards.js';
import {
  makePolicyDecision,
  mergePolicyDecisions,
  validatePolicyDecision,
} from './policy-decision.js';
import { classifyTool, isLocalSandboxTool } from './tool-risk-classifier.js';

/**
 * @typedef {{
 *   platform?: object | null,
 *   organization?: object | null,
 *   agentVersion?: object | null,
 *   tool?: object | null,
 *   request?: object | null,
 * }} PolicyLayers
 */

/**
 * @param {{
 *   layers?: PolicyLayers,
 *   auditSink?: (event: object) => Promise<void> | void,
 *   rateLimitPort?: { check?: (input: object) => Promise<{ allowed: boolean, reason?: string }> | { allowed: boolean, reason?: string } } | null,
 *   mcpReadOnlyTools?: Iterable<string>,
 *   mcpServerPolicies?: Record<string, { default?: string, readOnly?: boolean, tools?: Record<string, string> }>,
 *   agentVersionToolPolicy?: Record<string, string | { decision?: string }>,
 * }} [options]
 */
export function createPolicyEngine(options = {}) {
  const layers = options.layers || {};
  const auditSink = options.auditSink;
  const rateLimitPort = options.rateLimitPort ?? null;

  /**
   * @param {{
   *   toolName: string,
   *   args?: unknown,
   *   runContext?: object,
   * }} input
   */
  async function evaluateToolCall(input) {
    const toolName = String(input.toolName || '');
    const args = input.args;
    const runContext = input.runContext || {};

    /** @type {import('./policy-decision.js').PolicyDecision[]} */
    const stack = [];

    // ── Platform base ────────────────────────────────────────────────
    if (!runContext.sandboxSessionId && isLocalSandboxTool(toolName)) {
      stack.push(
        makePolicyDecision({
          decision: 'deny',
          reasonCode: 'SANDBOX_SESSION_REQUIRED',
          reason: 'local tools require sandboxSessionId binding',
          policyId: 'platform:sandbox-binding',
          riskLevel: 'critical',
        }),
      );
    } else {
      stack.push(
        makePolicyDecision({
          decision: 'allow',
          reasonCode: 'PLATFORM_DEFAULT',
          reason: 'platform baseline allow pending classification',
          policyId: 'platform:baseline',
          riskLevel: 'low',
        }),
      );
    }

    // Layer injections (may only tighten). Await async evaluators in fixed order.
    for (const [layerName, layer] of [
      ['platform', layers.platform],
      ['organization', layers.organization],
      ['agentVersion', layers.agentVersion],
      ['tool', layers.tool],
      ['request', layers.request],
    ]) {
      if (!layer) continue;
      const fromLayer = await extractLayerDecision(
        layer,
        toolName,
        args,
        runContext,
      );
      if (fromLayer) {
        stack.push({
          ...fromLayer,
          policyId: fromLayer.policyId || `${layerName}:injected`,
        });
      }
    }

    // ── Classification + local guards ────────────────────────────────
    const cls = classifyTool(toolName, {
      mcpReadOnlyTools: options.mcpReadOnlyTools,
      mcpServerPolicies: options.mcpServerPolicies,
    });

    if (cls.class === 'internal_interaction') {
      stack.push(
        makePolicyDecision({
          decision: 'allow',
          reasonCode: 'INTERNAL_INTERACTION_ALLOW',
          reason: 'ask_user is a durable user interaction, not an external side effect',
          policyId: 'platform:interaction',
          riskLevel: 'low',
        }),
      );
    } else if (cls.class === 'local_low') {
      const guard = evaluateLocalArgGuards(toolName, args);
      if (guard) {
        stack.push(guard);
      } else {
        stack.push(
          makePolicyDecision({
            decision: 'allow',
            reasonCode: 'LOCAL_SANDBOX_ALLOW',
            reason: 'local sandbox tool with valid binding and args',
            policyId: 'platform:local-low',
            riskLevel: 'low',
          }),
        );
      }
    } else if (cls.class === 'external_readonly') {
      // plan §14.2: external readonly must be audited AND rate-limited.
      // Absent/malformed/throwing limiter → deny fail-closed (do not also push allow).
      const rateDecision = await evaluateExternalReadonlyRateLimit(
        rateLimitPort,
        toolName,
        runContext,
      );
      if (rateDecision.decision === 'deny') {
        stack.push(rateDecision);
      } else {
        stack.push(
          makePolicyDecision({
            decision: 'allow',
            reasonCode: 'EXTERNAL_READONLY_ALLOW',
            reason: 'external read-only MCP tool explicitly allowed and rate-limited',
            policyId: 'platform:mcp-readonly',
            riskLevel: 'medium',
          }),
        );
      }
    } else if (cls.class === 'external_high') {
      const avPolicy = resolveAgentVersionToolPolicy(
        toolName,
        options.agentVersionToolPolicy,
        options.mcpServerPolicies,
        cls,
      );
      stack.push(avPolicy);
    } else {
      // unknown / internal
      stack.push(
        makePolicyDecision({
          decision: 'deny',
          reasonCode: 'UNKNOWN_TOOL_DENIED',
          reason: `unknown or internal tool denied: ${toolName || '(empty)'}`,
          policyId: 'platform:unknown-deny',
          riskLevel: 'critical',
        }),
      );
    }

    const decision = mergePolicyDecisions(stack);

    // ── Audit (required; allow fails closed if audit fails) ───────────
    const auditEvent = {
      type: 'policy.decision',
      decision: decision.decision,
      reasonCode: decision.reasonCode,
      reason: decision.reason,
      policyId: decision.policyId,
      riskLevel: decision.riskLevel,
      toolName,
      argsSummary: summarizeArgs(toolName, args),
      context: {
        orgId: runContext.orgId ?? null,
        userId: runContext.userId ?? null,
        conversationId: runContext.conversationId ?? null,
        agentSessionId: runContext.agentSessionId ?? null,
        runId: runContext.runId ?? null,
        sandboxSessionId: runContext.sandboxSessionId ?? null,
        traceId: runContext.traceId ?? null,
      },
    };

    if (typeof auditSink !== 'function') {
      if (decision.decision === 'allow') {
        return makePolicyDecision({
          decision: 'deny',
          reasonCode: 'POLICY_AUDIT_UNAVAILABLE',
          reason: 'audit sink unavailable; allow fail-closed',
          policyId: 'platform:audit',
          riskLevel: 'critical',
        });
      }
      // deny / require_approval without audit still returns decision (but prefer audit)
      return decision;
    }

    try {
      await auditSink(auditEvent);
    } catch {
      if (decision.decision === 'allow') {
        return makePolicyDecision({
          decision: 'deny',
          reasonCode: 'POLICY_AUDIT_FAILED',
          reason: 'audit sink failed; allow fail-closed',
          policyId: 'platform:audit',
          riskLevel: 'critical',
        });
      }
    }

    return decision;
  }

  return { evaluateToolCall };
}

/**
 * Await layer.evaluateToolCall when async so validatePolicyDecision never sees a Promise.
 * @param {unknown} layer
 * @param {string} toolName
 * @param {unknown} args
 * @param {object} runContext
 * @returns {Promise<import('./policy-decision.js').PolicyDecision | null>}
 */
async function extractLayerDecision(layer, toolName, args, runContext) {
  if (!layer || typeof layer !== 'object') return null;
  const L = /** @type {any} */ (layer);
  if (typeof L.evaluateToolCall === 'function') {
    let raw;
    try {
      raw = await L.evaluateToolCall({ toolName, args, runContext });
    } catch {
      return makePolicyDecision({
        decision: 'deny',
        reasonCode: 'LAYER_EVALUATOR_FAILED',
        reason: 'layer evaluateToolCall threw',
        policyId: L.policyId || 'layer:error',
        riskLevel: 'critical',
      });
    }
    return validatePolicyDecision(raw);
  }
  if (L.decision) {
    return validatePolicyDecision(L);
  }
  if (L.tools && typeof L.tools === 'object' && L.tools[toolName]) {
    const t = L.tools[toolName];
    if (typeof t === 'string') {
      return validatePolicyDecision({
        decision: t,
        reasonCode: 'LAYER_TOOL_POLICY',
        reason: `layer tool policy: ${t}`,
        policyId: L.policyId || 'layer:tool',
        riskLevel: L.riskLevel || 'medium',
      });
    }
    return validatePolicyDecision({
      riskLevel: 'medium',
      policyId: L.policyId || 'layer:tool',
      reasonCode: 'LAYER_TOOL_POLICY',
      reason: 'layer tool policy',
      ...t,
    });
  }
  if (L.defaultDecision) {
    return validatePolicyDecision({
      decision: L.defaultDecision,
      reasonCode: L.reasonCode || 'LAYER_DEFAULT',
      reason: L.reason || 'layer default',
      policyId: L.policyId || 'layer:default',
      riskLevel: L.riskLevel || 'medium',
    });
  }
  return null;
}

/**
 * Fail-closed rate limit gate for external readonly MCP tools.
 * Only explicit `{ allowed: true }` permits the subsequent allow decision.
 *
 * @param {any} rateLimitPort
 * @param {string} toolName
 * @param {object} runContext
 * @returns {Promise<import('./policy-decision.js').PolicyDecision>}
 */
async function evaluateExternalReadonlyRateLimit(
  rateLimitPort,
  toolName,
  runContext,
) {
  if (!rateLimitPort || typeof rateLimitPort.check !== 'function') {
    return makePolicyDecision({
      decision: 'deny',
      reasonCode: 'RATE_LIMIT_REQUIRED',
      reason:
        'external readonly MCP requires rateLimitPort.check; limiter absent',
      policyId: 'platform:rate-limit',
      riskLevel: 'high',
    });
  }

  let rl;
  try {
    rl = await rateLimitPort.check({
      toolName,
      runContext,
      class: 'external_readonly',
    });
  } catch {
    return makePolicyDecision({
      decision: 'deny',
      reasonCode: 'RATE_LIMIT_UNAVAILABLE',
      reason: 'rate limit port threw',
      policyId: 'platform:rate-limit',
      riskLevel: 'high',
    });
  }

  if (!rl || typeof rl !== 'object' || Array.isArray(rl)) {
    return makePolicyDecision({
      decision: 'deny',
      reasonCode: 'RATE_LIMIT_MALFORMED',
      reason: 'rate limit port returned non-object result',
      policyId: 'platform:rate-limit',
      riskLevel: 'high',
    });
  }

  if (rl.allowed === true) {
    return makePolicyDecision({
      decision: 'allow',
      reasonCode: 'RATE_LIMIT_OK',
      reason: 'rate limit check allowed',
      policyId: 'platform:rate-limit',
      riskLevel: 'low',
    });
  }

  // allowed !== true (false, undefined, or other) → deny
  return makePolicyDecision({
    decision: 'deny',
    reasonCode: rl.allowed === false ? 'RATE_LIMITED' : 'RATE_LIMIT_MALFORMED',
    reason:
      typeof rl.reason === 'string' && rl.reason
        ? rl.reason
        : rl.allowed === false
          ? 'rate limited'
          : 'rate limit port must return { allowed: true }',
    policyId: 'platform:rate-limit',
    riskLevel: 'medium',
  });
}

/**
 * @param {string} toolName
 * @param {Record<string, any> | undefined} agentVersionToolPolicy
 * @param {Record<string, any> | undefined} mcpServerPolicies
 * @param {{ serverId?: string, tool?: string }} cls
 */
function resolveAgentVersionToolPolicy(
  toolName,
  agentVersionToolPolicy,
  mcpServerPolicies,
  cls,
) {
  const byName =
    agentVersionToolPolicy &&
    (agentVersionToolPolicy[toolName] ||
      (cls.tool && agentVersionToolPolicy[cls.tool]));
  if (byName) {
    const decision =
      typeof byName === 'string' ? byName : byName.decision || 'require_approval';
    if (decision === 'allow' || decision === 'deny' || decision === 'require_approval') {
      return makePolicyDecision({
        decision,
        reasonCode: 'AGENT_VERSION_TOOL_POLICY',
        reason: `agent version tool policy: ${decision}`,
        policyId: 'agentVersion:toolPolicy',
        riskLevel: decision === 'deny' ? 'high' : 'high',
      });
    }
  }

  const serverPol =
    cls.serverId && mcpServerPolicies
      ? mcpServerPolicies[cls.serverId]
      : null;
  if (serverPol?.tools && cls.tool && serverPol.tools[cls.tool]) {
    const d = serverPol.tools[cls.tool];
    if (d === 'allow' || d === 'deny' || d === 'require_approval') {
      return makePolicyDecision({
        decision: d,
        reasonCode: 'MCP_SERVER_TOOL_POLICY',
        reason: `mcp server tool policy: ${d}`,
        policyId: `mcp:${cls.serverId}`,
        riskLevel: 'high',
      });
    }
  }
  if (serverPol?.default === 'allow' || serverPol?.default === 'deny') {
    return makePolicyDecision({
      decision: serverPol.default,
      reasonCode: 'MCP_SERVER_DEFAULT',
      reason: `mcp server default: ${serverPol.default}`,
      policyId: `mcp:${cls.serverId}`,
      riskLevel: 'high',
    });
  }

  // Default for external high risk: require_approval
  return makePolicyDecision({
    decision: 'require_approval',
    reasonCode: 'EXTERNAL_HIGH_RISK',
    reason: 'external side-effect tool requires approval',
    policyId: 'platform:mcp-high',
    riskLevel: 'high',
  });
}

/**
 * @param {string} toolName
 * @param {unknown} args
 */
function summarizeArgs(toolName, args) {
  if (!args || typeof args !== 'object') {
    return { toolName };
  }
  const a = /** @type {Record<string, unknown>} */ (args);
  /** @type {Record<string, unknown>} */
  const out = { toolName };
  if (typeof a.path === 'string') out.path = String(a.path).slice(0, 200);
  if (typeof a.command === 'string') {
    out.commandPreview = String(a.command).slice(0, 80);
    out.commandLen = String(a.command).length;
  }
  if (typeof a.code === 'string') out.codeLen = String(a.code).length;
  if (a.processId != null) out.processId = String(a.processId).slice(0, 64);
  if (a.env && typeof a.env === 'object') {
    out.envKeys = Object.keys(/** @type {object} */ (a.env)).slice(0, 16);
  }
  return redactPayload(out);
}
