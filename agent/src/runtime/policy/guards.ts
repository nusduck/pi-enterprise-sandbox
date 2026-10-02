/**
 * ctx.tools.guard() 单调兜底——返回拒绝后后续监听器无法翻案。
 *
 * 遇 deny 即短路返回已收集结果的合并值，后续监听器不再执行；merge 只用于
 * require_approval 之间的收敛。
 */

import { mergePolicyDecisions, type PolicyDecision } from './decision.js';

export type GuardListener = (toolName: string, args: Record<string, unknown>) => PolicyDecision | null;

/**
 * 按注册顺序跑监听器。遇 deny 即短路返回；require_approval 继续收集，
 * 最终合并收敛（allow 不能覆盖 deny/require_approval）。
 */
export function runGuards(
  listeners: readonly GuardListener[],
  toolName: string,
  args: Record<string, unknown>,
): PolicyDecision | null {
  const collected: PolicyDecision[] = [];
  for (const listener of listeners) {
    const hit = listener(toolName, args);
    if (hit === null) continue;
    collected.push(hit);
    if (hit.decision === 'deny') {
      return mergePolicyDecisions(collected);
    }
  }
  if (collected.length === 0) return null;
  return mergePolicyDecisions(collected);
}
