/**
 * Target Agent Service layout (plan §12.1).
 *
 * Production entrypoints remain at agent/*.js until later PRs migrate.
 * This file is the sole tracked marker for the target root `agent/src/`.
 * Nested empty package placeholders are intentionally omitted.
 *
 * Canonical layer list: `@pi-enterprise/contracts` → AGENT_TARGET_LAYOUT.
 */
export const SERVICE = 'agent' as const;
export const TARGET_ROOT = 'agent/src' as const;

export const LAYERS = [
  'bootstrap',
  'domain',
  'application',
  'runtime',
  'extensions',
  'infrastructure',
  'presentation',
] as const;

export const EXTENSIONS = [
  'sandbox-bridge',
  'enterprise-policy',
  'observability',
] as const;
