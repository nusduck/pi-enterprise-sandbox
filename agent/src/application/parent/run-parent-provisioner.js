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
import { ParentProvisioningRaceError, ValidationError } from '../errors.js';
import { assertUlid, isLegacyOrUuidIdentity } from '../../domain/shared/ulid.js';

/**
 * @typedef {{
 *   orgId: string,
 *   userId: string,
 *   provider: string,
 *   agentId: string,
 *   agentVersionId: string,
 *   conversationId: string,
 *   agentSessionId: string,
 *   sandboxSessionId: string,
 *   workspaceId: string,
 *   created: {
 *     organization: boolean,
 *     user: boolean,
 *     membership: boolean,
 *     agent: boolean,
 *     conversation: boolean,
 *     session: boolean,
 *   },
 * }} ParentGraph
 */

export class RunParentProvisioner {
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
  constructor(repos, opts) {
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
    this.repos = repos;
    this.generateId = opts.generateId;
    this.now = opts.now ?? (() => new Date());
    this.defaultProvider = opts.defaultProvider ?? DEFAULT_EXTERNAL_PROVIDER;
    /** Optional knex executor for parent row locks. */
    this.db = opts.db ?? null;
  }

  /**
   * @param {() => string} generateId
   * @returns {string}
   */
  #newUlid(generateId = this.generateId) {
    const id = generateId();
    if (isLegacyOrUuidIdentity(id)) {
      throw new ValidationError(
        'generateId must return a plan §5 ULID, not UUID/arun_',
      );
    }
    return assertUlid(id, 'generateId');
  }

  /**
   * Lock organization row when an executor is available.
   * @param {string} orgId
   */
  async #lockOrganization(orgId) {
    if (!this.db || typeof this.db !== 'function') return;
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
   * @returns {Promise<ParentGraph>}
   */
  async provision(auth) {
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

    /** @type {ParentGraph['created']} */
    const created = {
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

    // --- Tenant default agent ---
    const beforeAgent = await this.repos.catalog.getDefinitionByOrgAndName(
      orgId,
      'default',
    );
    const { definition, version } =
      await this.repos.catalog.ensureTenantDefaultAgent({
        orgId,
        createdBy: userId,
        generateId: () => this.#newUlid(),
      });
    created.agent = !beforeAgent;
    const agentId = assertUlid(definition.agentId, 'agentId');
    const agentVersionId = assertUlid(version.agentVersionId, 'agentVersionId');
    assertNotExternalInUlidSlot(agentId, 'agentId');
    assertNotExternalInUlidSlot(agentVersionId, 'agentVersionId');

    // --- Conversation ---
    const scope = { orgId, userId };
    let conversationId;
    const externalConversationId =
      auth.externalConversationId != null &&
      String(auth.externalConversationId).trim()
        ? requireExternalSubject(
            auth.externalConversationId,
            'externalConversationId',
          )
        : null;

    if (externalConversationId) {
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

/**
 * @param {unknown} err
 */
function isDup(err) {
  const code = /** @type {{ code?: string, errno?: number }} */ (err)?.code;
  const errno = /** @type {{ errno?: number }} */ (err)?.errno;
  return code === 'ER_DUP_ENTRY' || errno === 1062;
}
