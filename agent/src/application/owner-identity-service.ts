/**
 * 调用者的正式归属（org_id / user_id 两个 ULID）。
 *
 * exec 公共面按这两个 ID 判归属。会话作用域的请求由 `sandbox-session` 解析顺带给出；
 * 产物库这类**不针对某个会话**的请求没有会话可解析，BFF 用这里取归属。
 * 只解析已存在的映射（`resolveOwner`），不会顺手开通组织或用户。
 */
import { ExternalIdentityResolver, type ExternalAuth } from './parent/external-identity-resolver.js';

type Loose = any;

export class OwnerIdentityService {
  readonly db: Loose;
  readonly createRepositories: (db: Loose) => Loose;

  constructor(deps: { db: Loose; createRepositories: (db: Loose) => Loose }) {
    if (!deps?.db || typeof deps.createRepositories !== 'function') {
      throw new Error('OwnerIdentityService requires db and createRepositories');
    }
    this.db = deps.db;
    this.createRepositories = deps.createRepositories;
  }

  async resolve(auth: ExternalAuth): Promise<{ org_id: string; user_id: string }> {
    const repos = this.createRepositories(this.db);
    const owner = await new ExternalIdentityResolver({
      organizations: repos.organizations,
      externalRefs: repos.externalRefs,
    }).resolveOwner(auth);
    return { org_id: owner.orgId, user_id: owner.userId };
  }
}
