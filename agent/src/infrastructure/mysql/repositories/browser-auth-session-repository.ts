/**
 * 可撤销浏览器会话账本（design sso-integration-reservation §5.2，UPspec 表
 * `tbl_agsvc_browser_auth_sessions`）。
 *
 * 一行 = 一次本地登录/注册签发的会话。`revoke` 用 `WHERE revoked_at IS NULL`
 * 做幂等 CAS：并发退出只有一个写入生效，另一个拿到 0 行（调用方解释为 not_required）。
 * 不删除行——撤销是可审计事实，不是清理。
 */

import { formatDateTime, toMysqlDateTime } from '../row-mappers.js';

/** 过渡期宽松类型：注入的依赖多数还是 JS 类，形状由各自的模块负责。 */
type Loose = any;

const TABLE = 'tbl_agsvc_browser_auth_sessions';

function mapSession(row: Record<string, unknown> | undefined) {
  if (!row) return null;
  return {
    sessionId: String(row.session_id),
    userId: String(row.user_id),
    orgId: String(row.org_id),
    externalUserId: String(row.external_user_id),
    externalOrgId: String(row.external_org_id),
    loginMethod: String(row.login_method || 'local'),
    identityProvider: row.identity_provider == null ? null : String(row.identity_provider),
    source: String(row.source || ''),
    createdAt: formatDateTime(row.created_at),
    expiresAt: formatDateTime(row.expires_at),
    revokedAt: formatDateTime(row.revoked_at),
  };
}

export class BrowserAuthSessionRepository {
  db: Loose;
  now: () => Date;

  constructor(db: Loose, { now = () => new Date() }: { now?: () => Date } = {}) {
    if (!db) throw new Error('BrowserAuthSessionRepository requires a knex executor');
    this.db = db;
    this.now = now;
  }

  async create(input: {
    sessionId: string;
    userId: string;
    orgId: string;
    externalUserId: string;
    externalOrgId: string;
    loginMethod: string;
    identityProvider: string | null;
    source: string;
    createdAt: Date;
    expiresAt: Date;
  }) {
    await this.db(TABLE).insert({
      session_id: input.sessionId,
      user_id: input.userId,
      org_id: input.orgId,
      external_user_id: input.externalUserId,
      external_org_id: input.externalOrgId,
      login_method: input.loginMethod,
      identity_provider: input.identityProvider,
      source: input.source,
      created_at: toMysqlDateTime(input.createdAt),
      expires_at: toMysqlDateTime(input.expiresAt),
      revoked_at: null,
    });
    return this.getById(input.sessionId);
  }

  async getById(sessionId: string) {
    return mapSession(
      await this.db(TABLE).where({ session_id: sessionId }).first(),
    );
  }

  /** 幂等撤销：已撤销返回 false，调用方按 not_required 处理。 */
  async revoke(sessionId: string, revokedAt: Date = this.now()) {
    const updated = await this.db(TABLE)
      .where({ session_id: sessionId })
      .whereNull('revoked_at')
      .update({ revoked_at: toMysqlDateTime(revokedAt) });
    return Number(updated) > 0;
  }
}
