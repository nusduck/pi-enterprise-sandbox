/**
 * Enterprise extension logical names (plan §2.2).
 * Production AgentVersion.extensions must be exactly this set when non-empty.
 */

/** @type {readonly ['sandbox-bridge', 'enterprise-policy', 'observability']} */
export const ENTERPRISE_EXTENSION_NAMES = Object.freeze([
  'sandbox-bridge',
  'enterprise-policy',
  'observability',
]);

/** Fixed factory order for createEnterpriseExtensionBundle. */
export const ENTERPRISE_EXTENSION_ORDER = ENTERPRISE_EXTENSION_NAMES;

/**
 * Legacy enterprise-agent-kit package names (12) — non-production only.
 * New production composition must not load these via package loader.
 */
export const LEGACY_EXTENSION_PACKAGE_NAMES = Object.freeze([
  'sandbox-tools',
  'policy',
  'dynamic-resources',
  'observability',
  'mcp',
  'task-plan',
  'interaction',
  'context-management',
  'prompt',
  'structured-output',
  'skill-management',
  'capability-introspection',
]);
