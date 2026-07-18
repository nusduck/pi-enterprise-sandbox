/**
 * Enterprise Extension Bundle (plan §2.2 / PR-06 B1).
 *
 * Exactly three factories, fixed order, single-run closure context.
 * sandbox-bridge registers tools; enterprise-policy intercepts all tool_call.
 */

import {
  ENTERPRISE_EXTENSION_NAMES,
  ENTERPRISE_EXTENSION_ORDER,
  LEGACY_EXTENSION_PACKAGE_NAMES,
} from './constants.js';
import { createSandboxBridgeExtension } from './sandbox-bridge/index.js';
import { createEnterprisePolicyExtension } from './enterprise-policy/index.js';
import { createObservabilityExtension } from './observability/index.js';
import { SANDBOX_TOOL_NAMES } from './sandbox-bridge/constants.js';
import { createPolicyEngine } from './enterprise-policy/policy-engine.js';

export { FencedToolGovernanceRecorder } from '../application/fenced-tool-governance-recorder.js';

export {
  ENTERPRISE_EXTENSION_NAMES,
  ENTERPRISE_EXTENSION_ORDER,
  LEGACY_EXTENSION_PACKAGE_NAMES,
};
export {
  createSandboxBridgeExtension,
  SANDBOX_TOOL_NAMES,
  assertSandboxTransport,
  assertRunTransportIdentity,
  assertPositiveExecutionFenceToken,
  assertTransportToolCallId,
  buildTransportIdentity,
  buildTransportCallPayload,
  normalizeTransportToolCallId,
  MAX_TOOL_CALL_ID_LEN,
  RUN_TRANSPORT_IDENTITY_KEYS,
  TRANSPORT_CLAIM_KEYS,
  createSandboxBridgeToolDefinitions,
} from './sandbox-bridge/index.js';
export {
  createEnterprisePolicyExtension,
  validatePolicyDecision,
  makePolicyDecision,
  mergePolicyDecisions,
  createPolicyEngine,
  classifyTool,
  isLocalSandboxTool,
  evaluateLocalArgGuards,
} from './enterprise-policy/index.js';
export {
  createObservabilityExtension,
  extractUsageSummary,
  isSandboxBridgeOutcomeUnknown,
} from './observability/index.js';

/**
 * Exact tool allowlist for Pi createFromServices({ tools }).
 * @type {readonly string[]}
 */
export const ENTERPRISE_DEFAULT_TOOLS = SANDBOX_TOOL_NAMES;

const REQUIRED_CONTEXT_KEYS = Object.freeze([
  'orgId',
  'userId',
  'conversationId',
  'agentSessionId',
  'runId',
  'sandboxSessionId',
  'traceId',
  'executionFenceToken',
]);

/**
 * Positive finite integer fence for enterprise run context.
 * No coercion of strings/NaN/floats — fail closed.
 *
 * @param {unknown} token
 * @returns {number}
 */
function assertEnterpriseExecutionFenceToken(token) {
  if (typeof token !== 'number') {
    throw new Error(
      'createEnterpriseExtensionBundle runContext.executionFenceToken must be a positive finite integer number',
    );
  }
  if (!Number.isFinite(token) || !Number.isInteger(token) || token <= 0) {
    throw new Error(
      'createEnterpriseExtensionBundle runContext.executionFenceToken must be a positive finite integer',
    );
  }
  return token;
}

/**
 * @param {unknown} runContext
 */
export function assertEnterpriseRunContext(runContext) {
  if (!runContext || typeof runContext !== 'object' || Array.isArray(runContext)) {
    throw new Error(
      'createEnterpriseExtensionBundle requires runContext object with orgId/userId/conversationId/agentSessionId/runId/sandboxSessionId/traceId/executionFenceToken',
    );
  }
  const ctx = /** @type {Record<string, unknown>} */ (runContext);
  for (const key of REQUIRED_CONTEXT_KEYS) {
    if (!(key in ctx)) {
      throw new Error(
        `createEnterpriseExtensionBundle runContext missing required field: ${key}`,
      );
    }
    if (key === 'sandboxSessionId' || key === 'executionFenceToken') {
      continue;
    }
    if (ctx[key] == null || (typeof ctx[key] === 'string' && !String(ctx[key]).trim())) {
      throw new Error(
        `createEnterpriseExtensionBundle runContext.${key} must be a non-empty value`,
      );
    }
  }
  const executionFenceToken = assertEnterpriseExecutionFenceToken(
    ctx.executionFenceToken,
  );
  return Object.freeze({
    orgId: String(ctx.orgId),
    userId: String(ctx.userId),
    conversationId: String(ctx.conversationId),
    agentSessionId: String(ctx.agentSessionId),
    runId: String(ctx.runId),
    sandboxSessionId:
      ctx.sandboxSessionId == null ? null : String(ctx.sandboxSessionId),
    traceId: String(ctx.traceId),
    executionFenceToken,
  });
}

/**
 * @param {unknown} extensions
 */
export function assertExactEnterpriseExtensions(extensions) {
  if (extensions == null) {
    return { names: Object.freeze([]), empty: true };
  }
  if (!Array.isArray(extensions)) {
    throw new Error('AgentVersion.extensions must be an array when present');
  }
  if (extensions.length === 0) {
    return { names: Object.freeze([]), empty: true };
  }

  const names = extensions.map((e) => {
    if (typeof e === 'string') return e.trim();
    if (e && typeof e === 'object' && typeof e.name === 'string') {
      return String(e.name).trim();
    }
    return String(e ?? '').trim();
  });

  if (names.some((n) => !n)) {
    throw new Error('AgentVersion.extensions contains empty name');
  }

  const unique = new Set(names);
  if (unique.size !== names.length) {
    throw new Error('AgentVersion.extensions must not contain duplicates');
  }

  for (const n of names) {
    if (LEGACY_EXTENSION_PACKAGE_NAMES.includes(n) && n !== 'observability') {
      throw new Error(
        `AgentVersion.extensions rejects legacy package name "${n}" (use sandbox-bridge / enterprise-policy / observability only)`,
      );
    }
  }

  const expected = new Set(ENTERPRISE_EXTENSION_NAMES);
  if (unique.size !== expected.size || ![...unique].every((n) => expected.has(n))) {
    throw new Error(
      `AgentVersion.extensions when non-empty must be exactly [${ENTERPRISE_EXTENSION_NAMES.join(', ')}]; got [${names.join(', ')}]`,
    );
  }

  return {
    names: ENTERPRISE_EXTENSION_ORDER,
    empty: false,
  };
}

/**
 * Build the exact three ExtensionFactory functions for one Run.
 *
 * @param {object} runContext
 * @param {{
 *   recorder?: object | null,
 *   governanceRecorder?: object | null,
 *   sandboxTransport?: object | null,
 *   sandboxRequestBinder?: { bindSandboxRequest: Function } | null,
 *   policyEngine?: object | null,
 *   policyLayers?: object,
 *   auditSink?: Function,
 *   approvalCoordinator?: object | null,
 *   rateLimitPort?: object | null,
 *   runSuspensionPort?: object | null,
 *   mcpReadOnlyTools?: Iterable<string>,
 *   mcpServerPolicies?: object,
 *   agentVersionToolPolicy?: object,
 *   sandboxBridge?: object,
 *   enterprisePolicy?: object,
 *   observability?: object,
 *   now?: () => Date,
 * }} [deps]
 */
export function createEnterpriseExtensionBundle(runContext, deps = {}) {
  // Reject legacy sandboxClient — only explicit sandboxTransport is accepted.
  if (
    deps &&
    typeof deps === 'object' &&
    Object.prototype.hasOwnProperty.call(deps, 'sandboxClient')
  ) {
    throw new Error(
      'SANDBOX_CLIENT_REJECTED: createEnterpriseExtensionBundle rejects sandboxClient; inject deps.sandboxTransport only (service identity port, not browser Bearer)',
    );
  }

  const frozen = assertEnterpriseRunContext(runContext);

  // Enabled sandbox-bridge requires non-empty sandboxSessionId (plan runtime binding).
  if (
    frozen.sandboxSessionId == null ||
    !String(frozen.sandboxSessionId).trim() ||
    String(frozen.sandboxSessionId) === 'null' ||
    String(frozen.sandboxSessionId) === 'undefined'
  ) {
    throw new Error(
      'RUN_IDENTITY_REQUIRED: sandboxSessionId must be non-empty when creating enterprise extension bundle (sandbox-bridge enabled)',
    );
  }

  if (
    deps &&
    typeof deps === 'object' &&
    Array.isArray(/** @type {any} */ (deps).extraFactories) &&
    /** @type {any} */ (deps).extraFactories.length > 0
  ) {
    throw new Error(
      'createEnterpriseExtensionBundle rejects any fourth extension factory (extraFactories forbidden)',
    );
  }
  if (
    deps &&
    typeof deps === 'object' &&
    Array.isArray(/** @type {any} */ (deps).factories) &&
    /** @type {any} */ (deps).factories.length > 3
  ) {
    throw new Error(
      'createEnterpriseExtensionBundle rejects more than three factories',
    );
  }

  // Explicit port only — no sandboxClient fallback.
  const sandboxTransport = deps.sandboxTransport ?? null;

  // Auto-build policy engine from layers/audit when not explicitly provided.
  const governanceRecorder = deps.governanceRecorder ?? null;

  // PR-07B batch 2B: bind request-hash before Sandbox transport.
  // Prefer explicit sandboxRequestBinder; else wrap governanceRecorder.
  let sandboxRequestBinder = deps.sandboxRequestBinder ?? null;
  if (
    !sandboxRequestBinder &&
    governanceRecorder &&
    typeof governanceRecorder.bindSandboxRequest === 'function'
  ) {
    sandboxRequestBinder = {
      bindSandboxRequest: (input) =>
        governanceRecorder.bindSandboxRequest(input),
    };
  }

  let policyEngine = deps.policyEngine ?? null;
  if (
    !policyEngine &&
    (deps.policyLayers ||
      deps.auditSink ||
      deps.agentVersionToolPolicy ||
      deps.mcpReadOnlyTools ||
      deps.mcpServerPolicies ||
      governanceRecorder)
  ) {
    policyEngine = createPolicyEngine({
      layers: deps.policyLayers,
      auditSink:
        typeof deps.auditSink === 'function'
          ? deps.auditSink
          : governanceRecorder
            ? async () => {}
            : undefined,
      rateLimitPort: deps.rateLimitPort,
      mcpReadOnlyTools: deps.mcpReadOnlyTools,
      mcpServerPolicies: deps.mcpServerPolicies,
      agentVersionToolPolicy: deps.agentVersionToolPolicy,
    });
  }

  const sandboxBridge = createSandboxBridgeExtension({
    runContext: frozen,
    deps: {
      sandboxTransport,
      sandboxRequestBinder,
      ...(deps.sandboxBridge || {}),
    },
  });
  const enterprisePolicy = createEnterprisePolicyExtension({
    runContext: frozen,
    deps: {
      policyEngine,
      policyLayers: deps.policyLayers,
      auditSink: deps.auditSink,
      approvalCoordinator: deps.approvalCoordinator ?? null,
      rateLimitPort: deps.rateLimitPort ?? null,
      mcpReadOnlyTools: deps.mcpReadOnlyTools,
      mcpServerPolicies: deps.mcpServerPolicies,
      agentVersionToolPolicy: deps.agentVersionToolPolicy,
      governanceRecorder,
      runSuspensionPort: deps.runSuspensionPort ?? null,
      ...(deps.enterprisePolicy || {}),
    },
  });
  const observability = createObservabilityExtension({
    runContext: frozen,
    deps: {
      recorder: deps.recorder ?? null,
      governanceRecorder,
      now: deps.now,
      ...(deps.observability || {}),
    },
  });

  const factories = Object.freeze([
    sandboxBridge,
    enterprisePolicy,
    observability,
  ]);

  if (factories.length !== 3) {
    throw new Error('createEnterpriseExtensionBundle must return exactly 3 factories');
  }

  return factories;
}

/**
 * @param {readonly Function[]} factories
 * @returns {string[]}
 */
export function extensionFactoryNames(factories) {
  return (factories || []).map((f, i) => {
    if (typeof f === 'function' && typeof f.extensionName === 'string') {
      return f.extensionName;
    }
    return ENTERPRISE_EXTENSION_ORDER[i] ?? `unknown:${i}`;
  });
}
