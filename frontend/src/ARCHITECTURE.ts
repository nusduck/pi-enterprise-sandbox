/**
 * Target Frontend layout (plan §19.1).
 *
 * Existing app/entities/features/widgets/pages/shared implementations remain
 * authoritative. This file records the target top-level slices only — no empty
 * per-entity / per-feature / per-widget package placeholders.
 *
 * Canonical layer list: `@pi-enterprise/contracts` → FRONTEND_TARGET_LAYOUT.
 */
export const SERVICE = 'frontend' as const;
export const TARGET_ROOT = 'frontend/src' as const;

export const LAYERS = [
  'app',
  'entities',
  'features',
  'widgets',
  'pages',
  'shared',
] as const;
