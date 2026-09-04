/**
 * RunParentProvisioner — compatibility parent graph under one MySQL transaction.
 *
 * Provisions if absent (plan §8 parents for CreateRun):
 *   Organization, User, Membership,
 *   tenant default Agent Definition + Version,
 *   Conversation, active Agent Session
 *   with preallocated logical sandbox_session_id / workspace_id ULIDs.
 *
 * External BFF/Sandbox UUID/string subjects map only through:
 *   - organization_external_refs
 *   - users.external_subject (provider prefix)
 *   - conversation_external_refs
 * Never places external strings in CHAR(26) domain columns.
 *
 * Concurrency: locks a stable parent (organization / conversation) and relies
 * on unique refs; mapping races that require a full outer retry throw
 * {@link ParentProvisioningRaceError}.
 *
 * Does not claim that legacy Sandbox physical session id equals the logical ULID.
 */

import {
  formatUserExternalSubject,
} from '../../infrastructure/mysql/repositories/organization-repository.js';
import { ConflictError } from '../../infrastructure/mysql/errors.js';
import {
  assertNotExternalInUlidSlot,
  DEFAULT_EXTERNAL_PROVIDER,
  requireExternalSubject,
} from './external-identity-resolver.js';
import {
  OwnerScopedNotFoundError,
  ParentProvisioningRaceError,
  ValidationError,
} from '../errors.js';
import {
  assertUlid,
  isLegacyOrUuidIdentity,
  isUlid,
} from '../../domain/shared/ulid.js';

/** 过渡期宽松类型：注入的依赖多数还是 JS 类，形状由各自的模块负责。 */
type Loose = any;

export type ParentGraph = {
  orgId: string;
  userId: string;
  provider: string;
  agentId: string;
  agentVersionId: string;
  conversationId: string;
  agentSessionId: string;
  sandboxSessionId: string;
  workspaceId: string;
  created: {
    organization: boolean;
    user: boolean;
    membership: boolean;
    agent: boolean;
    conversation: boolean;
    session: boolean;
  };
};

export class RunParentProvisioner {
  // TS 要求类字段显式声明（JS 里它们只在构造器里赋值）。
  repos: Loose;
  generateId: Loose;
  now: Loose;
  defaultProvider: Loose;
  db: Loose;

  /**
   * @param {{
   *   organizations: import('../../infrastructure/mysql/repositories/organization-repository.js').OrganizationRepository,
   *   externalRefs: import('../../infrastructure/mysql/repositories/external-reference-repository.js').ExternalReferenceRepository,
   *   catalog: import('../../infrastructure/mysql/repositories/agent-catalog-repository.js').AgentCatalogRepository,
   *   conversations: import('../../infrastructure/mysql/repositories/conversation-repository.js').ConversationRepository,
   *   sessions: import('../../infrastructure/mysql/repositories/agent-session-repository.js').AgentSessionRepository,
   * }} repos
   * @param {{
   *   generateId: () => string,
   *   now?: () => Date,
   *   defaultProvider?: string,
   *   db?: import('knex').Knex | import('knex').Knex.Transaction,
   * }} opts
   */
  constructor(repos: { organizations: import('../../infrastructure/mysql/repositories/organization-repository.js').OrganizationRepository, externalRefs: import('../../infrastructure/mysql/repositories/external-reference-repository.js').ExternalReferenceRepository, catalog: import('../../infrastructure/mysql/repositories/agent-catalog-repository.js').AgentCatalogRepository, conversations: import('../../infrastructure/mysql/repositories/conversation-repository.js').ConversationRepository, sessions: import('../../infrastructure/mysql/repositories/agent-session-repository.js').AgentSessionRepository, }, opts: { generateId: () => string, now?: () => Date, defaultProvider?: string, db?: import('knex').Knex | import('knex').Knex.Transaction, }) {
    if (!repos?.organizations || !repos?.externalRefs || !repos?.catalog) {
      throw new Error(
        'RunParentProvisioner requires organizations, externalRefs, catalog',
      );
    }
    if (!repos?.conversations || !repos?.sessions) {
      throw new Error(
        'RunParentProvisioner requires conversations and sessions repositories',
      );
    }
    if (typeof opts?.generateId !== 'function') {
      throw new Error('RunParentProvisioner requires generateId()');
    }
    // Parent row locks (FOR UPDATE) and concurrent default-agent creation both
    // require a knex transaction/executor. Silently skipping the lock is a
    // landmine (triage A3); fail closed at construction instead.
    if (!opts?.db || typeof opts.db !== 'function') {
      throw new Error(
        'RunParentProvisioner requires db (knex transaction or connection) for parent row locks',
      );
    }
    this.repos = repos;
    this.generateId = opts.generateId;
    this.now = opts.now ?? (() => new Date());
    this.defaultProvider = opts.defaultProvider ?? DEFAULT_EXTERNAL_PROVIDER;
    /** Knex executor for parent row locks (required). */
    this.db = opts.db;
  }

  /**
   * @param generateId
   * @returns {string}
   */
  #newUlid(generateId: () => string = this.generateId) {
    const id = generateId();
    if (isLegacyOrUuidIdentity(id)) {
      throw new ValidationError(
        'generateId must return a plan §5 ULID, not UUID/arun_',
      );
    }
    return assertUlid(id, 'generateId');
  }

  /**
   * 已存在会话绑定的 Agent（D2：建会话时钉死，此后不可变）。
   *
   * 会话不存在 / 已归档 / 映射还没建时返回 null——那意味着"这次要新建会话"，
   * 由上层决定用显式选择还是租户默认。这里**只读不判权**：归属由
   * `getById` 的 owner scope 保证。
   */
  async #conversationAgentId(input: {
    orgId: string,
    userId: string,
    provider: string,
    externalConversationId: string,
  }) {
    const scope = { orgId: input.orgId, userId: input.userId };
    let conversationId = null;
    if (isUlid(input.externalConversationId)) {
      conversationId = input.externalConversationId;
    } else {
      const ref = await this.repos.externalRefs.getConversationRef({
        ...scope,
        provider: input.provider,
        externalSubject: input.externalConversationId,
      });
      conversationId = ref?.conversationId ?? null;
    }
    if (!conversationId || !isUlid(conversationId)) return null;
    const row = await this.repos.conversations.getById(conversationId, scope);
    if (!row || String(row.status || '').toLowerCase() === 'archived') return null;
    return row.agentId ?? null;
  }

  /**
   * Lock organization row (required for concurrent default-agent creation).
   * @param orgId
   */
  async #lockOrganization(orgId: string) {
    await this.db('organizations').where({ org_id: orgId }).forUpdate().first();
  }

  /**
   * @param {{
   *   provider?: string,
   *   externalOrgId: string,
   *   externalUserId: string,
   *   externalConversationId?: string | null,
   *   displayName?: string | null,
   *   email?: string | null,
   *   orgName?: string | null,
   * }} auth
   * @param [selection]
   * @returns {Promise<ParentGraph>}
   */
  async provision(auth: { provider?: string, externalOrgId: string, externalUserId: string, externalConversationId?: string | null, displayName?: string | null, email?: string | null, orgName?: string | null, }, selection: { agentId?: string | null } = {}) {
    if (!auth || typeof auth !== 'object') {
      throw new ValidationError('auth context is required for parent provisioning');
    }
    const provider = (auth.provider ?? this.defaultProvider).trim();
    if (!provider) throw new ValidationError('provider must be non-empty');

    const externalOrgId = requireExternalSubject(
      auth.externalOrgId,
      'externalOrgId',
    );
    const externalUserId = requireExternalSubject(
      auth.externalUserId,
      'externalUserId',
    );

    const created: ParentGraph['created'] = {
      organization: false,
      user: false,
      membership: false,
      agent: false,
      conversation: false,
      session: false,
    };

    // --- Organization ---
    let orgRef = await this.repos.externalRefs.getOrganizationRef(
      provider,
      externalOrgId,
    );
    let orgId;
    if (orgRef) {
      assertNotExternalInUlidSlot(orgRef.orgId, 'orgId');
      orgId = assertUlid(orgRef.orgId, 'orgId');
    } else {
      orgId = this.#newUlid();
      try {
        await this.repos.organizations.createOrganization({
          orgId,
          name: (auth.orgName && String(auth.orgName).trim()) || `org:${externalOrgId}`.slice(0, 255),
          status: 'active',
        });
        created.organization = true;
      } catch (err) {
        // Rare PK collision only; mapping race handled below.
        if (!(err instanceof ConflictError) && !isDup(err)) throw err;
        throw new ParentProvisioningRaceError(
          'Organization create race; retry transaction',
          { externalOrgId, provider },
        );
      }
      try {
        orgRef = await this.repos.externalRefs.getOrCreateOrganizationRef({
          provider,
          externalSubject: externalOrgId,
          orgId,
        });
      } catch (err) {
        if (err instanceof ConflictError) {
          throw new ParentProvisioningRaceError(
            'Organization external ref race; retry transaction',
            { externalOrgId, provider },
          );
        }
        throw err;
      }
      if (orgRef.orgId !== orgId) {
        // Concurrent writer won the mapping — abort so outer retry reloads.
        throw new ParentProvisioningRaceError(
          'Organization mapped to a different internal id; retry transaction',
          { expected: orgId, actual: orgRef.orgId },
        );
      }
    }
    assertNotExternalInUlidSlot(orgId, 'orgId');
    await this.#lockOrganization(orgId);

    // --- User ---
    const encodedUser = formatUserExternalSubject(provider, externalUserId);
    let user = await this.repos.organizations.getUserByExternalSubject(
      encodedUser,
    );
    let userId;
    if (user) {
      assertNotExternalInUlidSlot(user.userId, 'userId');
      userId = assertUlid(user.userId, 'userId');
    } else {
      userId = this.#newUlid();
      try {
        user = await this.repos.organizations.createUserIfAbsent({
          userId,
          externalSubject: encodedUser,
          displayName: auth.displayName ?? null,
          email: auth.email ?? null,
          status: 'active',
        });
        created.user = user.userId === userId;
      } catch (err) {
        if (err instanceof ConflictError) {
          throw new ParentProvisioningRaceError(
            'User external subject race; retry transaction',
            { externalUserId, provider },
          );
        }
        throw err;
      }
      userId = assertUlid(user.userId, 'userId');
    }

    // --- Membership (created flag from pre-check, not "just created user") ---
    const membershipBefore = await this.repos.organizations.getMembership({
      orgId,
      userId,
    });
    await this.repos.organizations.addMembershipIfAbsent({
      orgId,
      userId,
      role: 'member',
      status: 'active',
    });
    created.membership = !membershipBefore;

    const externalConversationId =
      auth.externalConversationId != null &&
      String(auth.externalConversationId).trim()
        ? requireExternalSubject(
            auth.externalConversationId,
            'externalConversationId',
          )
        : null;

    // --- Agent definition + immutable version ---
    // A2A credentials and the browser's new-conversation flow select an
    // explicit Agent. Resolve its active version in this transaction so a Run
    // can never silently fall back to tenant default.
    //
    // 没有显式选择时，**已存在的会话自己决定 Agent**（D2：绑定在建会话时钉死）。
    // 少了这一步，绑在非默认 Agent 上的会话在下一轮 follow-up 就会撞上
    // "Conversation is bound to a different agent"——调用方没选 Agent 并不等于
    // "改用租户默认"。
    const explicitAgentId = selection.agentId ?? null;
    const boundAgentId =
      explicitAgentId ??
      (externalConversationId
        ? await this.#conversationAgentId({
          orgId,
          userId,
          provider,
          externalConversationId,
        })
        : null);

    let definition;
    let version;
    if (boundAgentId) {
      const requestedAgentId = assertUlid(boundAgentId, 'agentId');
      definition = await this.repos.catalog.getDefinitionById(requestedAgentId);
      // 显式选择要求 status=active；会话**已经**绑定的 Agent 即便之后被停用也
      // 继续用它——换掉等于让同一个会话前后跑在两套配置上。
      if (
        !definition ||
        definition.orgId !== orgId ||
        (explicitAgentId != null &&
          String(definition.status).toLowerCase() !== 'active')
      ) {
        // 不存在、属于别的 org、已停用——三者返回同一个 404。存在性本身
        // 不能泄漏（AGENTS.md §2），所以这里不能用 403，也不能分开报错。
        throw new OwnerScopedNotFoundError('Agent not found', {
          resource: 'agent_definitions',
          id: requestedAgentId,
        });
      }
      if (!definition.activeVersionId) {
        throw new ValidationError('Selected agent has no active version');
      }
      version = await this.repos.catalog.getVersionById(
        assertUlid(definition.activeVersionId, 'activeVersionId'),
      );
      if (
        !version ||
        version.agentId !== requestedAgentId ||
        String(version.status).toLowerCase() !== 'active'
      ) {
        throw new ValidationError('Selected agent active version is unavailable');
      }
    } else {
      const beforeAgent = await this.repos.catalog.getDefinitionByOrgAndName(
        orgId,
        'default',
      );
      ({ definition, version } =
        await this.repos.catalog.ensureTenantDefaultAgent({
          orgId,
          createdBy: userId,
          generateId: () => this.#newUlid(),
        }));
      created.agent = !beforeAgent;
    }
    const agentId = assertUlid(definition.agentId, 'agentId');
    const agentVersionId = assertUlid(version.agentVersionId, 'agentVersionId');
    assertNotExternalInUlidSlot(agentId, 'agentId');
    assertNotExternalInUlidSlot(agentVersionId, 'agentVersionId');

    // --- Conversation ---
    const scope = { orgId, userId };
    let conversationId;

    if (externalConversationId) {
      if (isUlid(externalConversationId)) {
        conversationId = assertUlid(
          externalConversationId,
          'externalConversationId',
        );
        const locked = await this.repos.conversations.lockById(
          conversationId,
          scope,
        );
        if (
          !locked ||
          String(locked.status || '').toLowerCase() === 'archived'
        ) {
          throw new OwnerScopedNotFoundError('Conversation not found', {
            resource: 'conversations',
            id: conversationId,
          });
        }
        if (locked.agentId !== agentId) {
          throw new ValidationError('Conversation is bound to a different agent');
        }
      } else {
        let convRef = await this.repos.externalRefs.getConversationRef({
          orgId,
          userId,
          provider,
          externalSubject: externalConversationId,
        });
        if (convRef) {
          assertNotExternalInUlidSlot(convRef.conversationId, 'conversationId');
          conversationId = assertUlid(convRef.conversationId, 'conversationId');
          const locked = await this.repos.conversations.lockById(
            conversationId,
            scope,
          );
          if (!locked) {
            throw new ParentProvisioningRaceError(
              'Conversation ref exists but row missing; retry transaction',
              { conversationId },
            );
          }
          if (String(locked.status || '').toLowerCase() === 'archived') {
            throw new OwnerScopedNotFoundError('Conversation not found', {
              resource: 'conversations',
              id: conversationId,
            });
          }
          if (locked.agentId !== agentId) {
            throw new ValidationError(
              'Conversation is bound to a different agent',
            );
          }
        } else {
          conversationId = this.#newUlid();
          try {
            await this.repos.conversations.create({
              conversationId,
              orgId,
              userId,
              agentId,
              title: null,
              status: 'active',
            });
            created.conversation = true;
          } catch (err) {
            if (isDup(err) || err instanceof ConflictError) {
              throw new ParentProvisioningRaceError(
                'Conversation create race; retry transaction',
                { conversationId },
              );
            }
            throw err;
          }
          try {
            convRef = await this.repos.externalRefs.getOrCreateConversationRef({
              orgId,
              userId,
              provider,
              externalSubject: externalConversationId,
              conversationId,
            });
          } catch (err) {
            if (err instanceof ConflictError) {
              throw new ParentProvisioningRaceError(
                'Conversation external ref race; retry transaction',
                { externalConversationId, provider },
              );
            }
            throw err;
          }
          if (convRef.conversationId !== conversationId) {
            throw new ParentProvisioningRaceError(
              'Conversation mapped to a different internal id; retry transaction',
              {
                expected: conversationId,
                actual: convRef.conversationId,
              },
            );
          }
          await this.repos.conversations.lockById(conversationId, scope);
        }
      }
    } else {
      // No external conversation id → always create a fresh ULID conversation.
      conversationId = this.#newUlid();
      await this.repos.conversations.create({
        conversationId,
        orgId,
        userId,
        agentId,
        title: null,
        status: 'active',
      });
      created.conversation = true;
      await this.repos.conversations.lockById(conversationId, scope);
    }

    // --- Agent Session (logical sandbox_session_id / workspace_id ULIDs) ---
    let session = await this.repos.sessions.findActiveForConversation(
      conversationId,
      scope,
      { forUpdate: true },
    );
    let agentSessionId;
    let sandboxSessionId;
    let workspaceId;
    // Run binds to the session's fixed agent_version_id (plan §4/§8).
    // Reusing a session must NOT drift to the tenant's current default active version.
    let boundAgentVersionId = agentVersionId;
    if (session) {
      agentSessionId = assertUlid(session.agentSessionId, 'agentSessionId');
      sandboxSessionId = assertUlid(
        session.sandboxSessionId,
        'sandboxSessionId',
      );
      workspaceId = assertUlid(session.workspaceId, 'workspaceId');
      boundAgentVersionId = assertUlid(
        session.agentVersionId,
        'agentVersionId',
      );
      const sessionVersion = await this.repos.catalog.getVersionById(
        boundAgentVersionId,
      );
      if (!sessionVersion || sessionVersion.agentId !== agentId) {
        throw new ValidationError(
          'Agent session version does not match conversation agent',
        );
      }
      // Logical ULIDs only — not Sandbox physical session ids.
      assertNotExternalInUlidSlot(sandboxSessionId, 'sandboxSessionId');
      assertNotExternalInUlidSlot(workspaceId, 'workspaceId');
    } else {
      agentSessionId = this.#newUlid();
      sandboxSessionId = this.#newUlid();
      workspaceId = this.#newUlid();
      try {
        session = await this.repos.sessions.create({
          agentSessionId,
          orgId,
          userId,
          conversationId,
          agentVersionId,
          sandboxSessionId,
          workspaceId,
          status: 'ACTIVE',
        });
        created.session = true;
        boundAgentVersionId = agentVersionId;
      } catch (err) {
        if (isDup(err) || err instanceof ConflictError) {
          throw new ParentProvisioningRaceError(
            'Agent session create race; retry transaction',
            { conversationId },
          );
        }
        throw err;
      }
      // Point conversation at current session.
      await this.repos.conversations.updateMeta(conversationId, scope, {
        currentAgentSessionId: agentSessionId,
      });
    }

    return {
      orgId,
      userId,
      provider,
      agentId,
      agentVersionId: boundAgentVersionId,
      conversationId,
      agentSessionId,
      sandboxSessionId,
      workspaceId,
      created,
    };
  }
}

function isDup(err: unknown) {
  const code = (err as { code?: string, errno?: number })?.code;
  const errno = (err as { errno?: number })?.errno;
  return code === 'ER_DUP_ENTRY' || errno === 1062;
}
