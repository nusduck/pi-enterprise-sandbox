/**
 * 活跃 principal 准入（design sso-integration-reservation §5.1 / §5.2）。
 *
 * 「会话里的内部 user/org」是签发时的事实，但**不能用签发时的映射当作当前授权**：
 * 用户/组织被停用、Membership 被撤销、或映射被改到别的 owner，都必须在下一个请求
 * 就拒绝。所以这里每次读权威行（users / organizations / organization_memberships +
 * organization_external_refs），并核对 `sid` 的 owner 与兼容映射一致：
 *
 *   users.external_subject == `bff:<外部用户 ID>` 且
 *   organization_external_refs(bff, 外部组织 ID).org_id == 会话 org_id
 *
 * 不读 provisioning 缓存（`BrowserAuthService` 里也没有这个缓存了），不复用
 * `ExternalIdentityResolver`——那个 resolver 只查 Membership active，不查 user/org
 * status（design §2 已指出）。
 *
 * 失败语义：读失败/无法判定 → 503；读到但状态或映射不成立 → 401。区别很重要：
 * 401 让 BFF 走重新认证，503 让 BFF 显示可重试错误并保留草稿。
 */

import { formatUserExternalSubject } from '../infrastructure/mysql/repositories/organization-repository.js';
import { isUlid } from '../domain/shared/ulid.js';
import { browserAuthStoreUnavailable, invalidBrowserToken } from './browser-auth-errors.js';

export interface ActivePrincipalIdentity {
  readonly orgId: string;
  readonly userId: string;
}

export interface ActivePrincipalServiceDeps {
  readonly organizations: { getOrganization?(orgId: string): Promise<{ name: string; status?: unknown } | null>; getUser?(userId: string): Promise<{ userId: string; externalSubject: string; status: string } | null>; getMembership?(scope: { orgId: string; userId: string }): Promise<{ status: string } | null> };
  readonly externalRefs: { getOrganizationRef(provider: string, externalSubject: string): Promise<{ orgId: string } | null> };
}

export class ActivePrincipalService {
  readonly organizations: ActivePrincipalServiceDeps['organizations'];
  readonly externalRefs: ActivePrincipalServiceDeps['externalRefs'];

  constructor(deps: ActivePrincipalServiceDeps) {
    if (!deps?.organizations || !deps?.externalRefs) {
      throw new Error('ActivePrincipalService requires organizations and externalRefs');
    }
    this.organizations = deps.organizations;
    this.externalRefs = deps.externalRefs;
  }

  /**
   * 会话声称的 owner 是否仍是活跃成员。返回同一个 `{orgId,userId}` 便于调用方串链。
   */
  async resolveActive(input: {
    orgId: string;
    userId: string;
    externalUserId: string;
    externalOrgId: string;
  }): Promise<ActivePrincipalIdentity> {
    const orgId = String(input?.orgId || '').trim();
    const userId = String(input?.userId || '').trim();
    if (!isUlid(orgId) || !isUlid(userId)) throw invalidBrowserToken();

    let expectedSubject: string;
    try {
      expectedSubject = formatUserExternalSubject('bff', input.externalUserId);
    } catch {
      throw invalidBrowserToken();
    }

    let user: { userId: string; externalSubject: string; status: string } | null;
    let org: { name: string; status?: unknown } | null;
    let membership: { status: string } | null;
    let ref: { orgId: string } | null;
    try {
      user = await this.organizations.getUser!(userId);
      org = await this.organizations.getOrganization!(orgId);
      membership = await this.organizations.getMembership!({ orgId, userId });
      ref = await this.externalRefs.getOrganizationRef('bff', input.externalOrgId);
    } catch {
      throw browserAuthStoreUnavailable();
    }

    if (!user || String(user.status) !== 'active') throw invalidBrowserToken();
    if (!org || String(org.status) !== 'active') throw invalidBrowserToken();
    if (!membership || String(membership.status) !== 'active') throw invalidBrowserToken();
    // sid 的 owner 必须仍指向同一外部用户，且外部组织仍映射到同一 org。
    if (String(user.externalSubject) !== expectedSubject) throw invalidBrowserToken();
    if (!ref || String(ref.orgId) !== orgId) throw invalidBrowserToken();
    return { orgId, userId };
  }
}
