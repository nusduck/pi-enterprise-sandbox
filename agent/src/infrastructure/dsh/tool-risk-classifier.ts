/**
 * 工具风险分类。未知工具 fail-closed 为 unknown。
 */
import { SANDBOX_TOOL_NAMES } from './constants.js';

const LOCAL_SET = new Set([
  ...SANDBOX_TOOL_NAMES,
  'skill_list',
  'skill_install',
  'skill_uninstall',
  'spawn_subagent',
  'check_subagent',
  'todo_write',
  'memory_write',
  'memory_search',
]);

export function classifyTool(toolName) {
  const name = String(toolName || '');
  if (name === 'ask_user') return { class: 'internal_interaction' };
  if (LOCAL_SET.has(name)) return { class: 'local_low' };
  if (name.startsWith('mcp__')) return { class: 'external_high' };
  return { class: 'unknown' };
}

export function isLocalSandboxTool(toolName) {
  return LOCAL_SET.has(String(toolName || ''));
}
