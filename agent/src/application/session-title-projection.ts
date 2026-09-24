/**
 * 把 DSH 生成的会话标题投影到 Conversation.title。
 *
 * ## 为什么需要
 *
 * dsh-base 默认组合 `dsh-session-title` + `dsh-session-title-first-prompt-llm`：首条提问后
 * 用模型生成标题，写成会话日志里的 `session/title` 事件（落在 `tbl_agsvc_dsh_session_events`）。
 * 2026-09-25 之前没有任何代码读它——每个会话都花一次模型调用生成标题，然后丢掉；
 * Conversation.title 停在占位值，列表只能拿首条提问截断顶替。
 *
 * ## 规则
 *
 * - 只取 `source.kind === 'provider'`（模型生成）。DSH 的确定性回退（首句截断）与我们的
 *   `conversationTitleFromMessages` 等价，没必要写；写了反而让会话不再是占位，挡住随后
 *   才到的模型标题。
 * - 只覆盖**自动**标题：占位值（`isPlaceholderConversationTitle`），或首个 Run 由
 *   `CreateRunService` 从首条提问派生的标题（与 `conversationTitleFromMessages` 相同）。
 *   后者是常态——首个 Run 建立时就写了，模型标题几秒后才到（2026-09-25 真实链路发现）。
 *   建会话时显式给的标题、子 Agent 会话的标签标题都不动。
 * - 只投影到**当前**绑定这个 AgentSession 的会话，按 owner scope 读写。
 *
 * 由会话存储在事件**提交之后**调用：投影失败不得回滚或打断会话持久化，只留日志。
 */
import {
  conversationTitleFromMessages,
  isPlaceholderConversationTitle,
} from './conversation-title.js';

type Loose = any;

/** 与会话列表展示一致的上限（conversation-service normalizeTitle）。 */
const MAX_TITLE_CHARS = 500;
/** 判定「首条提问派生的标题」时读的消息条数；首条用户消息总在最前面。 */
const DERIVED_TITLE_SCAN_MESSAGES = 20;

export interface SessionEventLike {
  readonly type?: unknown;
  readonly data?: unknown;
}

/** 本批事件里最新的一条模型生成标题；没有返回 `null`。 */
export function latestProviderTitle(events: readonly SessionEventLike[]): string | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type !== 'session/title') continue;
    const data = event.data as { title?: unknown; source?: { kind?: unknown } } | undefined;
    if (data?.source?.kind !== 'provider') continue;
    const title = typeof data.title === 'string' ? data.title.replace(/\s+/g, ' ').trim() : '';
    if (title) return title.slice(0, MAX_TITLE_CHARS);
  }
  return null;
}

export function createSessionTitleProjector(deps: {
  transactionManager: { run: <T>(fn: (trx: Loose) => Promise<T>) => Promise<T> };
  createRepositories: (db: Loose) => Loose;
  log?: (message: string) => void;
}) {
  const log = deps.log ?? ((message: string) => console.warn(message));
  return async function onSessionEventsCommitted(
    owner: { orgId: string; userId: string },
    sessionId: string,
    events: readonly SessionEventLike[],
  ): Promise<void> {
    const title = latestProviderTitle(events);
    if (title === null) return;
    try {
      await deps.transactionManager.run(async (trx) => {
        const repos = deps.createRepositories(trx);
        const scope = { orgId: owner.orgId, userId: owner.userId };
        const session = await repos.sessions.getById(sessionId, scope);
        if (!session?.conversationId) return;
        const conversation = await repos.conversations.getById(session.conversationId, scope, {
          forUpdate: true,
        });
        if (!conversation) return;
        if (conversation.currentAgentSessionId && conversation.currentAgentSessionId !== sessionId) return;
        if (conversation.title === title) return;
        if (!isPlaceholderConversationTitle(conversation.title)) {
          const messages = await repos.messages.listByConversation(conversation.conversationId, scope, {
            limit: DERIVED_TITLE_SCAN_MESSAGES,
          });
          if (conversation.title !== conversationTitleFromMessages(messages)) return;
        }
        await repos.conversations.updateMeta(conversation.conversationId, scope, { title });
      });
    } catch (err) {
      log(
        `[session-title] projecting title for session ${sessionId} failed: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };
}
