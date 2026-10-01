/**
 * 浏览器认证单测的内存替身（session 账本 / 身份映射）。
 *
 * 只覆盖 `BrowserAuthService`、`BrowserSessionService`、`ActivePrincipalService`
 * 依赖的端口形状；真实事务、唯一约束与撤销 CAS 由
 * `agent/tests/mysql/browser-auth-session.integration.test.js` 在真库上证明。
 */

/** 过渡期宽松类型：测试替身不必逐字段声明。 */
type Loose = any;

/** 会话账本替身：行只增不删，`revoke` 是 `revoked_at` 的一次性 CAS。 */
export function memoryBrowserSessions() {
  const rows = new Map<string, Loose>();
  return {
    rows,
    failNextGet: false,
    failNextRevoke: false,
    async create(input: Loose) {
      const record = {
        sessionId: input.sessionId,
        userId: input.userId,
        orgId: input.orgId,
        externalUserId: input.externalUserId,
        externalOrgId: input.externalOrgId,
        loginMethod: input.loginMethod,
        identityProvider: input.identityProvider,
        source: input.source,
        createdAt: input.createdAt.toISOString(),
        expiresAt: input.expiresAt.toISOString(),
        revokedAt: null,
      };
      rows.set(record.sessionId, record);
      return { ...record };
    },
    async getById(sessionId: string) {
      if (this.failNextGet) {
        this.failNextGet = false;
        throw new Error('session store down');
      }
      const row = rows.get(sessionId);
      return row ? { ...row } : null;
    },
    async revoke(sessionId: string, revokedAt: Date) {
      if (this.failNextRevoke) {
        this.failNextRevoke = false;
        throw new Error('session store down');
      }
      const row = rows.get(sessionId);
      if (!row || row.revokedAt) return false;
      row.revokedAt = revokedAt.toISOString();
      return true;
    },
  };
}

/**
 * org/user/membership/external-ref 的一致内存映射。
 *
 * provisioning 会按需补建组织、用户与 Membership；`resolveActive` 再读回它们。
 * `counters` 同时记录 provisioning 调用与权威读调用，供「me 不重放 provisioning，
 * 但每次都核对活跃身份」这类断言使用。
 */
export function memoryIdentity(options: {
  orgId?: string;
  userId?: string;
  orgName?: string;
  userStatus?: string;
  orgStatus?: string;
  membershipStatus?: string;
} = {}) {
  const state = {
    // 合法 ULID（Crockford 无 I/L/O/U）：活跃准入会校验，替身也必须守同一条。
    orgId: options.orgId ?? '01M1ZRG0000000000000000000',
    userId: options.userId ?? '01M1ZSR0000000000000000000',
    orgName: options.orgName ?? '华东销售部',
    userStatus: options.userStatus ?? 'active',
    orgStatus: options.orgStatus ?? 'active',
    membershipStatus: options.membershipStatus ?? 'active',
  };
  const usersBySubject = new Map<string, Loose>();
  const usersById = new Map<string, Loose>();
  const orgs = new Map<string, Loose>();
  const memberships = new Map<string, Loose>();
  const orgRefs = new Map<string, string>();
  const counters = {
    orgRefLookups: 0,
    membershipWrites: 0,
    createdUsers: 0,
    userReads: 0,
    orgReads: 0,
    membershipReads: 0,
  };
  /** 调用入参快照：断言投影（displayName / role）用，不影响幂等语义。 */
  const createdUserInputs: Loose[] = [];
  const createdMembershipInputs: Loose[] = [];

  const organizations = {
    async createOrganization(input: Loose) {
      if (!orgs.has(input.orgId)) {
        orgs.set(input.orgId, { orgId: input.orgId, name: input.name, status: input.status });
      }
    },
    async getUserByExternalSubject(subject: string) {
      return usersBySubject.get(subject) ?? null;
    },
    async createUserIfAbsent(input: Loose) {
      createdUserInputs.push(input);
      const existing = usersBySubject.get(input.externalSubject);
      if (existing) return { userId: existing.userId };
      counters.createdUsers += 1;
      const user = {
        userId: input.userId,
        externalSubject: input.externalSubject,
        status: input.status,
      };
      usersBySubject.set(input.externalSubject, user);
      usersById.set(input.userId, user);
      return { userId: input.userId };
    },
    async addMembershipIfAbsent(input: Loose) {
      counters.membershipWrites += 1;
      createdMembershipInputs.push(input);
      const key = `${input.orgId}/${input.userId}`;
      if (!memberships.has(key)) {
        memberships.set(key, {
          orgId: input.orgId,
          userId: input.userId,
          role: input.role,
          status: input.status,
        });
      }
      return memberships.get(key);
    },
    async getUser(userId: string) {
      counters.userReads += 1;
      return usersById.get(userId) ?? null;
    },
    async getOrganization(orgId: string) {
      counters.orgReads += 1;
      if (orgs.has(orgId)) return orgs.get(orgId);
      if (orgId === state.orgId) {
        return { orgId, name: state.orgName, status: state.orgStatus };
      }
      return null;
    },
    async getMembership({ orgId, userId }: Loose) {
      counters.membershipReads += 1;
      return memberships.get(`${orgId}/${userId}`) ?? null;
    },
  };

  const externalRefs = {
    async getOrganizationRef(_provider: string, subject: string) {
      counters.orgRefLookups += 1;
      const orgId = orgRefs.get(subject);
      return orgId ? { orgId } : null;
    },
    async getOrCreateOrganizationRef(ref: Loose) {
      if (!orgRefs.has(ref.externalSubject)) orgRefs.set(ref.externalSubject, ref.orgId);
      return { orgId: orgRefs.get(ref.externalSubject) };
    },
  };

  return {
    state,
    organizations,
    externalRefs,
    counters,
    createdUserInputs,
    createdMembershipInputs,
    usersBySubject,
    usersById,
    orgs,
    memberships,
    orgRefs,
  };
}
