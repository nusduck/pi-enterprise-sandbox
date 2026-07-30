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
import {
  coerceToolRiskPolicy,
  decisionForRiskLevel,
  resolveToolRiskLevel,
} from './tool-risk-policy.js';

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
 *   toolRiskPolicy?: object,
 * }} [options]
 */
export function createPolicyEngine(options = {}) {
  const layers = options.layers || {};
  const auditSink = options.auditSink;
  const rateLimitPort = options.rateLimitPort ?? null;
  // Invalid risk config must fail at engine construction, not silently at the
  // first tool call of a production run.
  const riskPolicy = coerceToolRiskPolicy(options.toolRiskPolicy, {
    field: 'toolRiskPolicy',
  });

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

    // ── Classification + risk resolution + local guards ──────────────
    const cls = classifyTool(toolName, {
      mcpReadOnlyTools: options.mcpReadOnlyTools,
      mcpServerPolicies: options.mcpServerPolicies,
    });

    /** @type {{ riskLevel: string, source: string, configured: boolean } | null} */
    let resolvedRisk = null;

    // Unknown tools are denied before risk resolution: an operator must not be
    // able to make an unrecognized tool executable by assigning it a low risk.
    if (
      cls.class !== 'internal_interaction' &&
      cls.class !== 'local_low' &&
      cls.class !== 'external_readonly' &&
      cls.class !== 'external_high'
    ) {
      stack.push(
        makePolicyDecision({
          decision: 'deny',
          reasonCode: 'UNKNOWN_TOOL_DENIED',
          reason: `unknown or internal tool denied: ${toolName || '(empty)'}`,
          policyId: 'platform:unknown-deny',
          riskLevel: 'critical',
        }),
      );
    } else {
      const risk = resolveToolRiskLevel(toolName, cls, riskPolicy);
      resolvedRisk = risk;

      if (cls.class === 'local_low') {
        // Arg guards are independent of risk: a host-escape path is denied
        // however low the operator rated the tool.
        const guard = evaluateLocalArgGuards(toolName, args);
        if (guard) stack.push(guard);
      }

      if (cls.class === 'external_readonly') {
        // plan §14.2: external readonly must be audited AND rate-limited.
        // Absent/malformed/throwing limiter → deny fail-closed.
        const rateDecision = await evaluateExternalReadonlyRateLimit(
          rateLimitPort,
          toolName,
          runContext,
        );
        if (rateDecision.decision === 'deny') {
          stack.push(rateDecision);
        }
      }

      // An explicit per-tool decision (AgentVersion toolPolicy / MCP server
      // toolPolicy) overrides the risk→decision mapping for that one tool, but
      // still carries the resolved risk level into the audit record.
      const explicit =
        cls.class === 'external_high'
          ? resolveExplicitToolDecision(
              toolName,
              options.agentVersionToolPolicy,
              options.mcpServerPolicies,
              cls,
            )
          : null;

      if (explicit) {
        stack.push(
          makePolicyDecision({
            decision: explicit.decision,
            reasonCode: explicit.reasonCode,
            reason: explicit.reason,
            policyId: explicit.policyId,
            riskLevel: risk.riskLevel,
          }),
        );
      } else {
        stack.push(riskDecision(cls, risk, riskPolicy, toolName));
      }
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
      toolClass: cls.class,
      // Which risk-table entry priced this call — the operator needs this to
      // know which config line to edit when an approval looks wrong.
      riskSource: resolvedRisk?.source ?? null,
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
 * Reason codes preserve the pre-configuration vocabulary while the
 * configuration is at its defaults, so existing audit consumers and runbooks
 * keep working. A configured override announces itself as TOOL_RISK_POLICY.
 */
const CLASS_BASELINE = Object.freeze({
  internal_interaction: {
    decision: 'allow',
    reasonCode: 'INTERNAL_INTERACTION_ALLOW',
    reason:
      'ask_user is a durable user interaction, not an external side effect',
    policyId: 'platform:interaction',
  },
  local_low: {
    decision: 'allow',
    reasonCode: 'LOCAL_SANDBOX_ALLOW',
    reason: 'local sandbox tool with valid binding and args',
    policyId: 'platform:local-low',
  },
  external_readonly: {
    decision: 'allow',
    reasonCode: 'EXTERNAL_READONLY_ALLOW',
    reason: 'external read-only MCP tool explicitly allowed and rate-limited',
    policyId: 'platform:mcp-readonly',
  },
  external_high: {
    decision: 'require_approval',
    reasonCode: 'EXTERNAL_HIGH_RISK',
    reason: 'external side-effect tool requires approval',
    policyId: 'platform:mcp-high',
  },
});

/**
 * Turn a resolved risk level into the decision the risk table prices it at.
 *
 * @param {{ class?: string }} cls
 * @param {{ riskLevel: import('./tool-risk-policy.js').RiskLevel, source: string, configured: boolean }} risk
 * @param {import('./tool-risk-policy.js').ToolRiskPolicy} policy
 * @param {string} toolName
 */
function riskDecision(cls, risk, policy, toolName) {
  const decision = decisionForRiskLevel(risk.riskLevel, policy);
  const baseline =
    CLASS_BASELINE[/** @type {keyof typeof CLASS_BASELINE} */ (cls.class)];

  // Default risk, default mapping → keep the historical reason code.
  if (!risk.configured && baseline && decision === baseline.decision) {
    return makePolicyDecision({
      decision,
      reasonCode: baseline.reasonCode,
      reason: baseline.reason,
      policyId: baseline.policyId,
      riskLevel: risk.riskLevel,
    });
  }

  return makePolicyDecision({
    decision,
    reasonCode: 'TOOL_RISK_POLICY',
    reason: `configured risk ${risk.riskLevel} for ${toolName || '(empty)'} (${risk.source}) maps to ${decision}`,
    policyId: `toolRisk:${risk.source}`,
    riskLevel: risk.riskLevel,
  });
}

/**
 * Explicit per-tool decision from AgentVersion / MCP server tool policy.
 * Returns null when no explicit decision applies, so the caller falls back to
 * the risk→decision mapping.
 *
 * @param {string} toolName
 * @param {Record<string, any> | undefined} agentVersionToolPolicy
 * @param {Record<string, any> | undefined} mcpServerPolicies
 * @param {{ serverId?: string, tool?: string }} cls
 * @returns {{ decision: 'allow' | 'deny' | 'require_approval', reasonCode: string, reason: string, policyId: string } | null}
 */
function resolveExplicitToolDecision(
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
      return {
        decision,
        reasonCode: 'AGENT_VERSION_TOOL_POLICY',
        reason: `agent version tool policy: ${decision}`,
        policyId: 'agentVersion:toolPolicy',
      };
    }
  }

  const serverPol =
    cls.serverId && mcpServerPolicies
      ? mcpServerPolicies[cls.serverId]
      : null;
  if (serverPol?.tools && cls.tool && serverPol.tools[cls.tool]) {
    const d = serverPol.tools[cls.tool];
    if (d === 'allow' || d === 'deny' || d === 'require_approval') {
      return {
        decision: d,
        reasonCode: 'MCP_SERVER_TOOL_POLICY',
        reason: `mcp server tool policy: ${d}`,
        policyId: `mcp:${cls.serverId}`,
      };
    }
  }
  if (serverPol?.default === 'allow' || serverPol?.default === 'deny') {
    return {
      decision: serverPol.default,
      reasonCode: 'MCP_SERVER_DEFAULT',
      reason: `mcp server default: ${serverPol.default}`,
      policyId: `mcp:${cls.serverId}`,
    };
  }

  return null;
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
