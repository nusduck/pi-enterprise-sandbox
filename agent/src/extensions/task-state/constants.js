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
