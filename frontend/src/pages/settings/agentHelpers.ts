/**
 * Agents 管理页的纯函数部分：config 草稿的解析、格式化与"改了没有"的判定。
 *
 * 拆出来是为了能被 `test/` 直接测——页面本身要渲染 React，这里的规则不该只靠
 * 手点验证。服务端仍然会把同一份 config 再校验一遍（写入即校验），这里的解析
 * 只是让用户在按下按钮之前就看到 JSON 错在哪。
 */
import type { Agent, AgentVersion } from '../../shared/api';

export type ConfigDraftResult =
  | { ok: true; config: Record<string, unknown> }
  | { ok: false; error: string };

/** 空文本 = 空配置，而不是错误：新建 Agent 时不填 config 是常见的。 */
export function parseAgentConfigDraft(text: string): ConfigDraftResult {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return { ok: true, config: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return { ok: false, error: `Config must be valid JSON — ${(err as Error).message}` };
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Config must be a JSON object, not an array or scalar' };
  }
  return { ok: true, config: parsed as Record<string, unknown> };
}

/** 版本 config → 编辑框文本。稳定缩进，避免"只是换了个格式"的假 diff。 */
export function formatAgentConfig(config: Record<string, unknown> | undefined): string {
  return JSON.stringify(config ?? {}, null, 2);
}

/**
 * 草稿与当前活跃版本是否真的不同。
 *
 * 比较**解析后**再重新序列化的结果，而不是编辑框里的原文：只改了缩进或空白
 * 不该被当成"改了配置"，否则每次打开页面都会诱导用户建一个内容完全相同的新
 * 版本。键的书写顺序仍算差异——服务端的 `config_hash` 也是按序列化算的，把它
 * 当成"没变"会让页面和账本对同一件事给出两种说法。
 */
export function isConfigDraftChanged(
  draft: string,
  active: Record<string, unknown> | undefined,
): boolean {
  const parsed = parseAgentConfigDraft(draft);
  if (!parsed.ok) return true;
  return JSON.stringify(parsed.config) !== JSON.stringify(active ?? {});
}

/** 版本线里当前活跃的那一条。找不到时返回 null（指针悬空是异常但不该崩页面）。 */
export function activeVersionOf(
  agent: Agent | null | undefined,
  versions: AgentVersion[],
): AgentVersion | null {
  if (!agent?.active_version_id) return null;
  return versions.find((v) => v.agent_version_id === agent.active_version_id) ?? null;
}

/** 列表排序：默认 Agent 置顶，其余按名字。UI 稳定比"最近创建优先"更重要。 */
export function sortAgentsForDisplay(agents: Agent[]): Agent[] {
  return [...agents].sort((a, b) => {
    if (a.name === 'default' && b.name !== 'default') return -1;
    if (b.name === 'default' && a.name !== 'default') return 1;
    return a.name.localeCompare(b.name);
  });
}
