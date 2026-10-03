/**
 * 公司 SSO 身份关联（UPspec 表 `tbl_agsvc_sso_identities`，design sso-oidc-dev §3）。
 *
 * 只做 `(issuer, subject) → external_user_id` 的读写；凭据行由
 * `AuthCredentialRepository` 负责。两者的建号顺序与并发收敛在 `SsoLoginService`。
 */

import { formatDateTime, toMysqlDateTime } from '../row-mappers.js';
import type { Knex } from 'knex';

const TABLE = 'tbl_agsvc_sso_identities';

export interface SsoIdentityRecord {
  readonly identityId: string;
  readonly issuer: string;
  readonly subject: string;
  readonly externalUserId: string;
  readonly employeeId: string | null;
  readonly createdAt: string | null;
  readonly lastLoginAt: string | null;
}

function mapIdentity(row: Record<string, unknown> | undefined): SsoIdentityRecord | null {
  if (!row) return null;
  return {
    identityId: String(row.identity_id),
    issuer: String(row.issuer),
    subject: String(row.subject),
    externalUserId: String(row.external_user_id),
    employeeId: row.employee_id == null ? null : String(row.employee_id),
    createdAt: formatDateTime(row.created_at),
    lastLoginAt: formatDateTime(row.last_login_at),
  };
}

export class SsoIdentityRepository {
  db: Knex;
  now: () => Date;

  constructor(db: Knex, { now = () => new Date() }: { now?: () => Date } = {}) {
    if (!db) throw new Error('SsoIdentityRepository requires a knex executor');
    this.db = db;
    this.now = now;
  }

  async getBySubject(issuer: string, subject: string): Promise<SsoIdentityRecord | null> {
    return mapIdentity(await this.db(TABLE).where({ issuer, subject }).first());
  }

  /** 唯一约束冲突原样抛出，由调用方按「并发首次登录」重读收敛。 */
  async create(input: {
    identityId: string;
    issuer: string;
    subject: string;
    externalUserId: string;
    employeeId: string | null;
  }): Promise<SsoIdentityRecord | null> {
    const now = toMysqlDateTime(this.now());
    await this.db(TABLE).insert({
      identity_id: input.identityId,
      issuer: input.issuer,
      subject: input.subject,
      external_user_id: input.externalUserId,
      employee_id: input.employeeId,
      created_at: now,
      last_login_at: now,
    });
    return this.getBySubject(input.issuer, input.subject);
  }

  /** 每次登录刷新工号（IdP 侧可能补发）与最近登录时间。 */
  async touchLogin(identityId: string, employeeId: string | null): Promise<void> {
    await this.db(TABLE)
      .where({ identity_id: identityId })
      .update({
        employee_id: employeeId,
        last_login_at: toMysqlDateTime(this.now()),
      });
  }
}
