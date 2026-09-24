/**
 * ctx.tools.guard() 单调兜底——返回拒绝后后续监听器无法翻案。
 *
 * DSH waterfall：第一个返回拒绝的监听器拥有决定权。我们再包一层 merge，
 * 即使错误地继续调用后续监听器，allow 也不能覆盖 deny。
 */

import { mergePolicyDecisions, type PolicyDecision } from './decision.js';

export type GuardListener = (toolName: string, args: Record<string, unknown>) => PolicyDecision | null;

/**
 * 按注册顺序跑监听器。一旦出现 deny / require_approval，丢掉后面的放行结果。
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
