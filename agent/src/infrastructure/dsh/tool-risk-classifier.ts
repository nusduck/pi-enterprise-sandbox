/**
 * 工具风险分类。未知工具 fail-closed 为 unknown。
 *
 * 名单引用 `runtime/policy/tool-names.ts` 的唯一事实源（ADR 0009 D4）——
 * **不要在这里再列一份**。2026-08-31 之前这里额外挂着 `skill_*`/`spawn_subagent`/
 * `check_subagent`/`memory_*`，与 `risk-table.ts` 的那份已经漂成两套名字。
 */
import {
  ASK_USER_TOOL_NAME,
  SANDBOX_TOOL_NAMES,
  isRetiredToolName,
} from './constants.js';

const LOCAL_SET = new Set(SANDBOX_TOOL_NAMES);

export function classifyTool(toolName) {
  const name = String(toolName || '');
  if (name === ASK_USER_TOOL_NAME) return { class: 'internal_interaction' };
  if (LOCAL_SET.has(name)) return { class: 'local_low' };
  if (name.startsWith('mcp__')) return { class: 'external_high' };
  return { class: 'unknown' };
}

export function isLocalSandboxTool(toolName) {
  return LOCAL_SET.has(String(toolName || ''));
}

/** 已退役能力（ADR 0009 D7/D10）——区别于「没见过的工具」，理由码不同。 */
export { isRetiredToolName };
