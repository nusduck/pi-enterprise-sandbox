/**
 * HiAgent 远端会话绑定仓储（docs/design/hiagent-remote-delegation.md §3/H3）。
 *
 * 一行 = 一个平台会话对一个远端的「当前远端会话」。查询一律带 org/user scope：
 * 同一个 conversation_id 换了 user 也查不到别人的绑定（跨租户一律无行，
 * 不区分「没有」与「不是你的」）。
 *
 * 只存远端会话 ID，不存任何凭据（AppKey 只活在进程内存，见 H1）。
 */

import { applyOwnerScope, requireOwnerScope } from '../ownership.js';
import { toMysqlDateTime } from '../row-mappers.js';
import { assertUlid } from '../../../domain/shared/ulid.js';

/** 过渡期宽松类型：注入的依赖多数还是 JS 类，形状由各自的模块负责。 */
type Loose = any;

export const REMOTE_CONVERSATIONS_TABLE = 'tbl_agsvc_remote_conversations';

export interface RemoteConversationScope {
  readonly orgId: string;
  readonly userId: string;
  readonly conversationId: string;
}

export class RemoteConversationRepository {
  // TS 要求类字段显式声明（JS 里它们只在构造器里赋值）。
  db: Loose;
  generateId: Loose;

  constructor(db: import('knex').Knex | import('knex').Knex.Transaction, opts: { generateId?: () => string } = {}) {
    if (!db) throw new Error('RemoteConversationRepository requires a knex executor');
    this.db = db;
    this.generateId = opts.generateId ?? null;
  }

  /**
   * 查绑定：命中返回远端会话 ID，否则 `null`。查不到与跨 scope 一律 `null`。
   */
  async getBinding(scope: RemoteConversationScope, remoteAgentId: string): Promise<string | null> {
    const s = requireOwnerScope(scope);
    const conversationId = assertUlid((scope as Loose).conversationId, 'conversationId');
    const row = await applyOwnerScope(
      this.db(REMOTE_CONVERSATIONS_TABLE).where({
        conversation_id: conversationId,
        remote_agent_id: remoteAgentId,
      }),
      s,
    ).first();
    const id = row?.remote_conversation_id;
    return typeof id === 'string' && id ? id : null;
  }

  /**
   * 落绑定（upsert：同一 `(conversation_id, remote_agent_id)` 覆盖）。
   * 覆盖即续聊切换——旧远端会话留在 HiAgent 侧自然过期，不在这里删。
   */
  async setBinding(scope: RemoteConversationScope, remoteAgentId: string, remoteConversationId: string): Promise<void> {
    if (typeof this.generateId !== 'function') {
      throw new Error('RemoteConversationRepository requires generateId() for writes');
    }
    const s = requireOwnerScope(scope);
    const conversationId = assertUlid((scope as Loose).conversationId, 'conversationId');
    const remoteId = String(remoteConversationId ?? '').trim();
    if (!remoteId || remoteId.length > 191) {
      throw new Error('RemoteConversationRepository requires a remote conversation id of 1-191 chars');
    }
    const now = toMysqlDateTime(new Date());
    const existing = await applyOwnerScope(
      this.db(REMOTE_CONVERSATIONS_TABLE).where({
        conversation_id: conversationId,
        remote_agent_id: remoteAgentId,
      }),
      s,
    ).first();
    if (existing) {
      await applyOwnerScope(
        this.db(REMOTE_CONVERSATIONS_TABLE).where({
          conversation_id: conversationId,
          remote_agent_id: remoteAgentId,
        }),
        s,
      ).update({ remote_conversation_id: remoteId, updated_at: now });
      return;
    }
    await this.db(REMOTE_CONVERSATIONS_TABLE).insert({
      binding_id: this.generateId(),
      org_id: s.orgId,
      user_id: s.userId,
      conversation_id: conversationId,
      remote_agent_id: remoteAgentId,
      remote_conversation_id: remoteId,
      created_at: now,
      updated_at: now,
    });
  }

  /** 删绑定（H5 会话失效路径；幂等，不存在也不报错）。 */
  async clearBinding(scope: RemoteConversationScope, remoteAgentId: string): Promise<void> {
    const s = requireOwnerScope(scope);
    const conversationId = assertUlid((scope as Loose).conversationId, 'conversationId');
    await applyOwnerScope(
      this.db(REMOTE_CONVERSATIONS_TABLE).where({
        conversation_id: conversationId,
        remote_agent_id: remoteAgentId,
      }),
      s,
    ).del();
  }
}
