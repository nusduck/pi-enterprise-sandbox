/**
 * Target BFF / API Server layout (plan §18.2).
 *
 * Production entrypoints remain at api-server/*.js until later PRs migrate.
 * This file is the sole tracked marker for the target root `api-server/src/`.
 *
 * Canonical layer list: `@pi-enterprise/contracts` → API_SERVER_TARGET_LAYOUT.
 */
export const SERVICE = 'api-server' as const;
export const TARGET_ROOT = 'api-server/src' as const;

export const LAYERS = ['middleware', 'routes', 'clients', 'services'] as const;

/** BFF must not own these concerns (plan §18.1). */
export const NON_RESPONSIBILITIES = [
  'agent-loop',
  'tool-dispatch',
  'run-state-machine',
  'session-restore',
  'process-management',
  'pi-event-parsing',
  'workspace-lifecycle',
] as const;
