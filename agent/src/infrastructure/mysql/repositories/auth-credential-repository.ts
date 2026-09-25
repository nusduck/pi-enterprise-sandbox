import { formatDateTime, toMysqlDateTime } from '../row-mappers.js';

type Loose = any;

function mapCredential(row: Record<string, unknown> | undefined) {
  if (!row) return null;
  return {
    id: String(row.external_user_id),
    username: String(row.username),
    passwordHash: String(row.password_hash),
    email: row.email == null ? null : String(row.email),
    displayName: row.display_name == null ? null : String(row.display_name),
    role: String(row.role || 'user'),
    organizationId: String(row.external_org_id || 'org_bootstrap'),
    isActive: Boolean(row.is_active),
    createdAt: formatDateTime(row.created_at),
    lastLoginAt: formatDateTime(row.last_login_at),
  };
}

/** Password credentials live in Agent's MySQL schema, beside identity mappings. */
export class AuthCredentialRepository {
  db: Loose;
  now: () => Date;

  constructor(db: Loose, { now = () => new Date() } = {}) {
    if (!db) throw new Error('AuthCredentialRepository requires a knex executor');
    this.db = db;
    this.now = now;
  }

  async create(input: {
    username: string;
    passwordHash: string;
    externalUserId: string;
    externalOrgId: string;
    email: string | null;
    displayName: string | null;
    role: string;
  }) {
    const now = toMysqlDateTime(this.now());
    await this.db('tbl_agsvc_auth_credentials').insert({
      username: input.username,
      password_hash: input.passwordHash,
      external_user_id: input.externalUserId,
      external_org_id: input.externalOrgId,
      email: input.email,
      display_name: input.displayName || input.username,
      role: input.role,
      is_active: true,
      created_at: now,
      updated_at: now,
      last_login_at: null,
    });
    return this.getByUsername(input.username);
  }

  async getByUsername(username: string) {
    return mapCredential(
      await this.db('tbl_agsvc_auth_credentials').where({ username }).first(),
    );
  }

  async getByExternalUserId(externalUserId: string) {
    return mapCredential(
      await this.db('tbl_agsvc_auth_credentials')
        .where({ external_user_id: externalUserId })
        .first(),
    );
  }

  async setRole(externalUserId: string, role: string) {
    await this.db('tbl_agsvc_auth_credentials')
      .where({ external_user_id: externalUserId })
      .update({ role, updated_at: toMysqlDateTime(this.now()) });
  }

  async touchLogin(externalUserId: string) {
    const now = toMysqlDateTime(this.now());
    await this.db('tbl_agsvc_auth_credentials')
      .where({ external_user_id: externalUserId })
      .update({ last_login_at: now, updated_at: now });
  }

  /**
   * 修改本人的显示名称 / 邮箱。`auth_credentials` 与 `users` 各存一份（后者是
   * 运行账本与通知收件人的来源），同一事务里一起改，不留下一半的状态。
   * `patch` 里没出现的键保持不变。
   */
  async updateProfile(
    externalUserId: string,
    userExternalSubject: string,
    patch: { displayName?: string; email?: string | null },
  ) {
    const now = toMysqlDateTime(this.now());
    const fields: Record<string, unknown> = {};
    if (patch.displayName !== undefined) fields.display_name = patch.displayName;
    if (patch.email !== undefined) fields.email = patch.email;
    if (Object.keys(fields).length) {
      await this.db.transaction(async (trx: Loose) => {
        await trx('tbl_agsvc_auth_credentials')
          .where({ external_user_id: externalUserId })
          .update({ ...fields, updated_at: now });
        await trx('tbl_agsvc_users')
          .where({ external_subject: userExternalSubject })
          .update({ ...fields, updated_at: now });
      });
    }
    return this.getByExternalUserId(externalUserId);
  }
}
