/**
 * 会话列表的纯投影。
 *
 * 从 `ChatContext.tsx` 拆出来：那个文件负责聊天的状态机与副作用，而这里只是
 * 「列表里换掉一条」和「这条会话被绑定的版本钉了哪个模型」两个纯函数。
 * 服务端是语义权威：`model_policy.fixed_model_id` 由 Agent 按会话实际绑定的
 * AgentVersion 返回，前端**不从 Agent 的最新活跃版本反推**旧会话的模型。
 */
import type { ConversationSummary } from '../../shared/state/types';

/** 用服务端返回的最新字段覆盖列表里的同一条，其余保持原引用。 */
export function mergeConversation(
  conversations: readonly ConversationSummary[] | null | undefined,
  next: ConversationSummary,
): ConversationSummary[] {
  return (conversations || []).map((conversation) =>
    conversation.id === next.id ? { ...conversation, ...next } : conversation,
  );
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
