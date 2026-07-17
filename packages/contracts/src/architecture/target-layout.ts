/**
 * Target architecture layout (plan §12.1, §16.1, §18.2, §19.1).
 *
 * Canonical, importable description of top-level service layering.
 * Service trees keep a single ARCHITECTURE marker file; empty per-feature
 * package placeholders are intentionally not created.
 */

export interface ServiceTargetLayout {
  /** Service id used across docs and scaffolding. */
  service: 'agent' | 'api-server' | 'sandbox' | 'frontend';
  /** Repo-relative root for the target layout. */
  root: string;
  /** Plan section reference. */
  planSection: string;
  /** Top-level layers / slices only (not nested empty packages). */
  layers: readonly string[];
  /** Hard constraints called out by the design. */
  constraints?: readonly string[];
}

/** Agent Service target (plan §12.1). */
export const AGENT_TARGET_LAYOUT = {
  service: 'agent',
  root: 'agent/src',
  planSection: '12.1',
  layers: [
    'bootstrap',
    'domain',
    'application',
    'runtime',
    'extensions',
    'infrastructure',
    'presentation',
  ],
  constraints: [
    'extensions limited to sandbox-bridge, enterprise-policy, observability',
    'domain has no I/O',
    'presentation does not own run state machine',
  ],
} as const satisfies ServiceTargetLayout;

/** Allowed enterprise extensions (plan §2.2 / §12.1). */
export const AGENT_EXTENSIONS = [
  'sandbox-bridge',
  'enterprise-policy',
  'observability',
] as const;

/** BFF / API Server target (plan §18.2). */
export const API_SERVER_TARGET_LAYOUT = {
  service: 'api-server',
  root: 'api-server/src',
  planSection: '18.2',
  layers: ['middleware', 'routes', 'clients', 'services'],
  constraints: [
    'no agent loop',
    'no tool dispatch',
    'no run state machine authority',
    'no session restore ownership',
    'no process management',
    'no pi private event parsing',
    'no workspace lifecycle decisions',
  ],
} as const satisfies ServiceTargetLayout;

/** Sandbox Service target (plan §16.1). */
export const SANDBOX_TARGET_LAYOUT = {
  service: 'sandbox',
  root: 'sandbox/app',
  planSection: '16.1',
  layers: [
    'api',
    'domain',
    'services',
    'isolation',
    'persistence',
    'security',
    'observability',
  ],
  constraints: [
    'session workspace one-to-one',
    'paths via unified path resolver',
    'no agent conversation storage',
  ],
} as const satisfies ServiceTargetLayout;

/** Frontend target slices (plan §19.1) — top-level only. */
export const FRONTEND_TARGET_LAYOUT = {
  service: 'frontend',
  root: 'frontend/src',
  planSection: '19.1',
  layers: ['app', 'entities', 'features', 'widgets', 'pages', 'shared'],
  constraints: [
    'entities hold domain state shapes',
    'features compose use-cases',
    'widgets are presentational composition',
    'pages are route-level only',
  ],
} as const satisfies ServiceTargetLayout;

/** All service target layouts for static import / review. */
export const TARGET_LAYOUTS = [
  AGENT_TARGET_LAYOUT,
  API_SERVER_TARGET_LAYOUT,
  SANDBOX_TARGET_LAYOUT,
  FRONTEND_TARGET_LAYOUT,
] as const;

export type TargetLayout = (typeof TARGET_LAYOUTS)[number];
