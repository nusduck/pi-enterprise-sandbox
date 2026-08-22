/**
 * subagent-spawn tool name constants.
 *
 * Kept in a leaf module so the enterprise-policy risk classifier can import
 * them without pulling in the whole extension (which imports typebox and the
 * sandbox-bridge result helpers).
 */

/** Tools registered by the subagent-spawn extension. */
export const SUBAGENT_TOOL_NAMES = Object.freeze([
  'spawn_subagent',
  'check_subagent',
]);

/** Nesting cap: a child may spawn, a grandchild may not. */
export const MAX_SUBAGENT_DEPTH = 2;

/** Live (non-terminal) children one parent Run may hold at once. */
export const MAX_CONCURRENT_CHILDREN = 5;
