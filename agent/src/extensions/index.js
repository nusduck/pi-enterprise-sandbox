/**
 * Enterprise Extension Bundle (plan §2.2 / PR-06 B1).
 *
 * Registry-driven: every required extension plus any AgentVersion-enabled
 * optional first-party extension, in fixed load order, sharing one per-Run
 * closure context. sandbox-bridge and user-interaction register tools;
 * enterprise-policy intercepts all tool_call; observability records outcomes.
 */

import {
  EXTENSION_LOAD_ORDER,
  LEGACY_EXTENSION_PACKAGE_NAMES,
  LEGACY_REQUIRED_EXTENSION_NAMES,
  OPTIONAL_EXTENSION_NAMES,
  REGISTERED_EXTENSION_NAMES,
  REQUIRED_EXTENSION_NAMES,
} from './constants.js';
import { createSandboxBridgeExtension } from './sandbox-bridge/index.js';
import { createUserInteractionExtension } from './user-interaction/index.js';
import { createEnterprisePolicyExtension } from './enterprise-policy/index.js';
import { createObservabilityExtension } from './observability/index.js';
import { createSkillLifecycleExtension } from './skill-lifecycle/index.js';
import { SANDBOX_TOOL_NAMES } from './sandbox-bridge/constants.js';
import { createPolicyEngine } from './enterprise-policy/policy-engine.js';
import {
  coerceToolRiskPolicy,
  mergeToolRiskPolicies,
} from './enterprise-policy/tool-risk-policy.js';

export { FencedToolGovernanceRecorder } from '../application/fenced-tool-governance-recorder.js';

export {
  EXTENSION_LOAD_ORDER,
  LEGACY_EXTENSION_PACKAGE_NAMES,
  LEGACY_REQUIRED_EXTENSION_NAMES,
  OPTIONAL_EXTENSION_NAMES,
  REGISTERED_EXTENSION_NAMES,
  REQUIRED_EXTENSION_NAMES,
};
export { createUserInteractionExtension } from './user-interaction/index.js';
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
  DEFAULT_CLASS_RISK_LEVELS,
  DEFAULT_RISK_APPROVAL,
  RISK_CLASSES,
  ToolRiskPolicyError,
  coerceToolRiskPolicy,
  decisionForRiskLevel,
  defaultToolRiskPolicy,
  loadToolRiskPolicy,
  mergeToolRiskPolicies,
  resolveToolRiskLevel,
} from './enterprise-policy/index.js';
export {
  createObservabilityExtension,
  extractUsageSummary,
  isSandboxBridgeOutcomeUnknown,
} from './observability/index.js';
export {
  createSkillLifecycleExtension,
  SKILL_LIFECYCLE_TOOL_NAMES,
} from './skill-lifecycle/index.js';

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
 * Resolve AgentVersion.extensions against the first-party registry.
 *
 * - empty / null  → enterprise bundle off
 * - non-empty     → every name must be registered; every required name must
 *                   be present; optional names may be added.
 *
 * A list holding exactly the pre-`user-interaction` required three is
 * accepted and implies `user-interaction`, so ask_user does not silently
 * disappear from AgentVersions authored before the split.
 *
 * Returns the resolved names in deterministic load order.
 *
 * @param {unknown} extensions
 * @returns {{ names: readonly string[], empty: boolean }}
 */
export function assertEnterpriseExtensions(extensions) {
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

  const registered = new Set(REGISTERED_EXTENSION_NAMES);
  for (const n of names) {
    if (registered.has(n)) continue;
    if (LEGACY_EXTENSION_PACKAGE_NAMES.includes(n)) {
      throw new Error(
        `AgentVersion.extensions rejects legacy package name "${n}" (registered first-party extensions: ${REGISTERED_EXTENSION_NAMES.join(', ')})`,
      );
    }
    throw new Error(
      `AgentVersion.extensions contains unregistered extension "${n}"; only first-party extensions compiled into this image may load (${REGISTERED_EXTENSION_NAMES.join(', ')})`,
    );
  }

  // Legacy required-three list predates the user-interaction split.
  const isLegacyRequiredSet =
    unique.size === LEGACY_REQUIRED_EXTENSION_NAMES.length &&
    LEGACY_REQUIRED_EXTENSION_NAMES.every((n) => unique.has(n));

  if (!isLegacyRequiredSet) {
    const missing = REQUIRED_EXTENSION_NAMES.filter((n) => !unique.has(n));
    if (missing.length > 0) {
      throw new Error(
        `AgentVersion.extensions when non-empty must include every required extension; missing [${missing.join(', ')}]`,
      );
    }
  }

  const resolved = new Set(
    isLegacyRequiredSet ? REQUIRED_EXTENSION_NAMES : [...unique],
  );
  for (const n of REQUIRED_EXTENSION_NAMES) resolved.add(n);

  return {
    names: Object.freeze(EXTENSION_LOAD_ORDER.filter((n) => resolved.has(n))),
    empty: false,
  };
}


/**
 * Build the ExtensionFactory functions for one Run, in fixed load order.
 *
 * Factories are constructed here from the compiled-in registry only. Callers
 * select *which* registered extensions load (`deps.extensions`); they can
 * never supply a factory function, so no caller can inject code into the
 * extension trust boundary.
 *
 * @param {object} runContext
 * @param {{
 *   extensions?: readonly string[] | null,
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
 *   isDurableInteractionPending?: (toolCallId: string) => boolean,
 *   mcpReadOnlyTools?: Iterable<string>,
 *   mcpServerPolicies?: object,
 *   agentVersionToolPolicy?: object,
 *   toolRiskPolicy?: object,
 *   agentVersionToolRiskPolicy?: object,
 *   skillManager?: object | null,
 *   skillManagerFactory?: (runContext: object, lifecycleDeps?: { getAgentSession?: Function }) => object | null,
 *   getAgentSession?: () => object | null,
 *   sandboxBridge?: object,
 *   enterprisePolicy?: object,
 *   observability?: object,
 *   skillLifecycle?: object,
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

  // Callers select registered extensions by name; they never supply factory
  // functions. Extensions run inside the trust boundary (sandbox transport,
  // governance recorder, run context), so caller-provided code stays refused.
  for (const forbidden of ['extraFactories', 'factories']) {
    if (
      deps &&
      typeof deps === 'object' &&
      Array.isArray(/** @type {any} */ (deps)[forbidden]) &&
      /** @type {any} */ (deps)[forbidden].length > 0
    ) {
      throw new Error(
        `createEnterpriseExtensionBundle rejects caller-supplied extension factories (deps.${forbidden}); select registered extensions by name via deps.extensions`,
      );
    }
  }

  const selected = new Set(
    Array.isArray(deps.extensions) && deps.extensions.length > 0
      ? assertEnterpriseExtensions([...deps.extensions]).names
      : REQUIRED_EXTENSION_NAMES,
  );
  for (const name of REQUIRED_EXTENSION_NAMES) selected.add(name);

  // The SkillManager is per-Run because the writable skill directory is
  // per-user: `skillManagerFactory(runContext)` binds it to this Run's
  // orgId/userId. A pre-built `deps.skillManager` is accepted for tests only.
  let skillManager = deps.skillManager ?? null;
  if (!skillManager && typeof deps.skillManagerFactory === 'function') {
    skillManager = deps.skillManagerFactory(frozen, {
      getAgentSession:
        typeof deps.getAgentSession === 'function' ? deps.getAgentSession : undefined,
    });
  }
  const skillManagerReady = Boolean(
    skillManager &&
      typeof skillManager.install === 'function' &&
      typeof skillManager.create === 'function' &&
      skillManager.userSkillRoot,
  );

  // When the AgentVersion did not spell out an extension list, skill-lifecycle
  // loads wherever installation is enabled. An explicit non-empty list stays
  // authoritative — pi-runtime-factory validates the factories against it
  // exactly, so silently appending would turn a valid AgentVersion into a
  // PI_EXTENSIONS_COUNT error.
  if (
    skillManagerReady &&
    !(Array.isArray(deps.extensions) && deps.extensions.length > 0)
  ) {
    selected.add('skill-lifecycle');
  }
  if (selected.has('skill-lifecycle') && !skillManagerReady) {
    throw new Error(
      'SKILL_MANAGER_REQUIRED: AgentVersion enables skill-lifecycle but no SkillManager with a per-user directory was injected',
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

  // Risk table: platform layer first, AgentVersion layer may only tighten it.
  const toolRiskPolicy = mergeToolRiskPolicies(
    coerceToolRiskPolicy(deps.toolRiskPolicy, { field: 'platform.toolRiskPolicy' }),
    deps.agentVersionToolRiskPolicy
      ? coerceToolRiskPolicy(deps.agentVersionToolRiskPolicy, {
          field: 'agentVersion.toolRiskPolicy',
        })
      : null,
  );

  let policyEngine = deps.policyEngine ?? null;
  if (
    !policyEngine &&
    (deps.policyLayers ||
      deps.auditSink ||
      deps.agentVersionToolPolicy ||
      deps.mcpReadOnlyTools ||
      deps.mcpServerPolicies ||
      deps.toolRiskPolicy ||
      deps.agentVersionToolRiskPolicy ||
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
      toolRiskPolicy,
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
      toolRiskPolicy,
      governanceRecorder,
      runSuspensionPort: deps.runSuspensionPort ?? null,
      ...(deps.enterprisePolicy || {}),
    },
  });
  const observabilityDeps = {
    recorder: deps.recorder ?? null,
    governanceRecorder,
    now: deps.now,
    ...(deps.observability || {}),
  };
  // The executor owns the ephemeral pending-interaction signal. Keep the
  // predicate on the observability boundary so only the matching ask_user
  // tool call can avoid ordinary error terminalization.
  if (typeof deps.isDurableInteractionPending === 'function') {
    observabilityDeps.isDurableInteractionPending =
      deps.isDurableInteractionPending;
  }
  // Model identity is safe metadata; credentials and full model config stay
  // outside the extension dependency boundary.
  if (typeof deps.modelId === 'string' && deps.modelId.trim()) {
    observabilityDeps.modelId = deps.modelId;
  }
  if (typeof deps.provider === 'string' && deps.provider.trim()) {
    observabilityDeps.provider = deps.provider;
  }
  // Audit truncation limits (env-tunable; defaults preserve historical sizes).
  if (deps.deltaTruncateLimit != null) {
    observabilityDeps.deltaTruncateLimit = deps.deltaTruncateLimit;
  }
  if (deps.thinkingTruncateLimit != null) {
    observabilityDeps.thinkingTruncateLimit = deps.thinkingTruncateLimit;
  }
  const observability = createObservabilityExtension({
    runContext: frozen,
    deps: observabilityDeps,
  });

  const userInteraction = createUserInteractionExtension({
    runContext: frozen,
    deps: {
      governanceRecorder,
      runSuspensionPort: deps.runSuspensionPort ?? null,
      ...(deps.userInteraction || {}),
    },
  });

  /** @type {Record<string, Function>} */
  const built = {
    'sandbox-bridge': sandboxBridge,
    'user-interaction': userInteraction,
    'enterprise-policy': enterprisePolicy,
    observability,
  };

  if (selected.has('skill-lifecycle')) {
    built['skill-lifecycle'] = createSkillLifecycleExtension({
      runContext: frozen,
      deps: {
        skillManager,
        currentTurnAttachments: deps.currentTurnAttachments,
        ...(deps.skillLifecycle || {}),
      },
    });
  }

  const factories = Object.freeze(
    EXTENSION_LOAD_ORDER.filter((name) => selected.has(name)).map((name) => {
      const factory = built[name];
      if (typeof factory !== 'function') {
        throw new Error(
          `createEnterpriseExtensionBundle has no factory for registered extension "${name}"`,
        );
      }
      return factory;
    }),
  );

  for (const name of REQUIRED_EXTENSION_NAMES) {
    if (!factories.some((f) => f.extensionName === name)) {
      throw new Error(
        `createEnterpriseExtensionBundle must include required extension "${name}"`,
      );
    }
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
    return EXTENSION_LOAD_ORDER[i] ?? `unknown:${i}`;
  });
}
