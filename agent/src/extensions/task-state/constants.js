/**
 * task-state tool name constants.
 *
 * Leaf module so the enterprise-policy risk classifier can import the names
 * without pulling in typebox and the extension factory surface.
 */

/** Tools registered by the task-state extension. */
export const TASK_STATE_TOOL_NAMES = Object.freeze([
  'todo_write',
  'todo_read',
  'memory_write',
  'memory_search',
]);

/**
 * Store methods the extension needs before it can register anything.
 *
 * Kept beside the tool names so both the auto-selection check and the
 * assembly-time guard in the bundle read the same list — a store that grows a
 * method must not leave the two disagreeing about what "wired" means.
 */
export const TASK_STATE_STORE_METHODS = Object.freeze([
  'replaceTodos',
  'getTodos',
  'appendMemory',
  'searchMemory',
]);
