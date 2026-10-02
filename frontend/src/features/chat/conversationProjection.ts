/**
 * 会话列表的纯投影。
 *
 * 从 `ChatContext.tsx` 拆出来：那个文件负责聊天的状态机与副作用，而这里只是
 * 「列表里换掉一条」和「这条会话被绑定的版本钉了哪个模型」两个纯函数。
 * 服务端是语义权威：`model_policy.fixed_model_id` 由 Agent 按会话实际绑定的
 * AgentVersion 返回，前端**不从 Agent 的最新活跃版本反推**旧会话的模型。
 */
import type { ConversationSummary } from '../../shared/state/types';

/**
 * 本地新建或更新的会话一律 unshift 到顶（§2.4）；若已存在则更新字段并移至最前。
 */
export function mergeConversation(
  conversations: readonly ConversationSummary[] | null | undefined,
  next: ConversationSummary,
): ConversationSummary[] {
  const list = conversations || [];
  const nextId = (next as any).conversation_id || next.id;
  const existing = list.find((c) => c.id === nextId);
  const updated: ConversationSummary = existing
    ? { ...existing, ...next, id: nextId }
    : { ...next, id: nextId };
  return [updated, ...list.filter((c) => c.id !== nextId)];
}

/**
 * 该会话被固定的模型 ID；没有固定或查不到这条会话时返回 null。
 *
 * 返回 null 只表示「没有固定」，不表示「可以随便选」——可选集合仍由目录决定。
 */
export function fixedModelIdOf(
  conversations: readonly ConversationSummary[] | null | undefined,
  conversationId: string | null | undefined,
): string | null {
  const id = String(conversationId || '').trim();
  if (!id) return null;
  const conversation = (conversations || []).find((candidate) => candidate.id === id);
  const fixed = conversation?.model_policy?.fixed_model_id;
  return typeof fixed === 'string' && fixed.trim() ? fixed.trim() : null;
}
