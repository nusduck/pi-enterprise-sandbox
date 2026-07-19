/**
 * Owner-scoped Conversation CRUD backed exclusively by Agent MySQL.
 *
 * Delete is implemented as archival because conversations are referenced by
 * durable sessions, messages, and runs that must remain available for audit.
 */

import {
  OwnerScopedNotFoundError,
  ParentProvisioningRaceError,
  ValidationError,
} from './errors.js';
import { RunParentProvisioner } from './parent/run-parent-provisioner.js';
import { ExternalIdentityResolver } from './parent/external-identity-resolver.js';
import { assertUlid, isUlid } from '../domain/shared/ulid.js';

const MAX_CREATE_ATTEMPTS = 3;

function normalizeTitle(value) {
  if (value != null && typeof value !== 'string') {
    throw new ValidationError('title must be a string');
  }
  const title = value == null ? 'New chat' : String(value).trim();
  const normalized = title || 'New chat';
  if (normalized.length > 500) {
    throw new ValidationError('title exceeds max length 500');
  }
  return normalized;
}

function isArchived(row) {
  return row?.archivedAt != null || String(row?.status || '').toLowerCase() === 'archived';
}

export function presentConversation(row) {
  return {
    id: row.conversationId,
    title: row.title || 'New chat',
    sandbox_session_id: null,
    agent_session_id: row.currentAgentSessionId ?? null,
    workspace_id: null,
    messages: [],
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    status: row.status,
  };
}

export class ConversationService {
  /**
   * @param {{
 *   transactionManager: { run: Function },
 *   createRepositories: (db: any) => any,
 *   db: any,
 *   generateId: () => string,
 *   now?: () => Date,
 *   sessionProvisioner?: { ensure: Function } | null,
 * }} deps
   */
  constructor(deps) {
    if (!deps?.transactionManager || typeof deps.transactionManager.run !== 'function') {
      throw new Error('ConversationService requires transactionManager');
    }
    if (typeof deps.createRepositories !== 'function' || !deps.db) {
      throw new Error('ConversationService requires repositories and db');
    }
    if (typeof deps.generateId !== 'function') {
      throw new Error('ConversationService requires generateId');
    }
    this.tx = deps.transactionManager;
    this.createRepositories = deps.createRepositories;
    this.db = deps.db;
    this.generateId = deps.generateId;
    this.now = deps.now ?? (() => new Date());
    this.sessionProvisioner = deps.sessionProvisioner ?? null;
  }

  async #resolveOwner(auth, repos = this.createRepositories(this.db)) {
    const resolver = new ExternalIdentityResolver({
      organizations: repos.organizations,
      externalRefs: repos.externalRefs,
    });
    return resolver.resolveOwner(auth);
  }

  async list(auth, opts = {}) {
    const repos = this.createRepositories(this.db);
    let owner;
    try {
      owner = await this.#resolveOwner(auth, repos);
    } catch (err) {
      // A trusted principal with no provisioned owner has no conversations yet.
      if (err instanceof OwnerScopedNotFoundError) return [];
      throw err;
    }
    const rows = await repos.conversations.listForOwner(owner, {
      limit: opts.limit ?? 200,
      includeArchived: false,
    });
    return rows.map(presentConversation);
  }

  async get(conversationId, auth) {
    if (!isUlid(conversationId)) {
      throw new ValidationError('conversationId must be a ULID');
    }
    const id = assertUlid(conversationId, 'conversationId');
    const repos = this.createRepositories(this.db);
    const owner = await this.#resolveOwner(auth, repos);
    const row = await repos.conversations.getById(id, owner);
    if (!row || isArchived(row)) {
      throw new OwnerScopedNotFoundError('Conversation not found', {
        resource: 'conversations',
        id,
      });
    }
    return presentConversation(row);
  }

  async create(auth, input = {}) {
    if (input == null || typeof input !== 'object' || Array.isArray(input)) {
      throw new ValidationError('conversation body must be an object');
    }
    const title = normalizeTitle(input.title);
    let lastRace = null;
    for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt += 1) {
      try {
        return await this.tx.run(async (trx) => {
          const repos = this.createRepositories(trx);
          const provisioner = new RunParentProvisioner(
            {
              organizations: repos.organizations,
              externalRefs: repos.externalRefs,
              catalog: repos.catalog,
              conversations: repos.conversations,
              sessions: repos.sessions,
            },
            {
              generateId: this.generateId,
              now: this.now,
              db: trx,
            },
          );
          const parents = await provisioner.provision({
            ...auth,
            externalConversationId: null,
          });
          const scope = { orgId: parents.orgId, userId: parents.userId };
          const row = await repos.conversations.updateMeta(
            parents.conversationId,
            scope,
            { title },
          );

          // Browser APIs expose the internal ULID. Register it as a stable BFF
          // external subject so CreateRun can resolve the same conversation.
          await repos.externalRefs.getOrCreateConversationRef({
            orgId: parents.orgId,
            userId: parents.userId,
            provider: auth.provider || 'bff',
            externalSubject: parents.conversationId,
            conversationId: parents.conversationId,
          });
          return presentConversation(row);
        });
      } catch (err) {
        if (!(err instanceof ParentProvisioningRaceError)) throw err;
        lastRace = err;
      }
    }
    throw lastRace || new ParentProvisioningRaceError();
  }

  async delete(conversationId, auth) {
    if (!isUlid(conversationId)) {
      throw new ValidationError('conversationId must be a ULID');
    }
    const id = assertUlid(conversationId, 'conversationId');
    return this.tx.run(async (trx) => {
      const repos = this.createRepositories(trx);
      const owner = await this.#resolveOwner(auth, repos);
      const current = await repos.conversations.getById(id, owner, {
        forUpdate: true,
      });
      if (!current || isArchived(current)) {
        throw new OwnerScopedNotFoundError('Conversation not found', {
          resource: 'conversations',
          id,
        });
      }
      await repos.conversations.archive(id, owner, this.now());
    });
  }

  async ensureSession(auth, input = {}) {
    if (!this.sessionProvisioner?.ensure) {
      const error = new Error('Sandbox session provisioning unavailable');
      error.code = 'SANDBOX_SESSION_PROVISION_FAILED';
      throw error;
    }
    if (input == null || typeof input !== 'object' || Array.isArray(input)) {
      throw new ValidationError('session ensure body must be an object');
    }
    const rawConversationId =
      input.conversationId ?? input.conversation_id ?? null;
    let conversationId = null;
    let selectedAgentId = null;
    if (rawConversationId != null && rawConversationId !== '') {
      if (!isUlid(rawConversationId)) {
        throw new ValidationError('conversationId must be a ULID');
      }
      conversationId = assertUlid(rawConversationId, 'conversationId');
      const repos = this.createRepositories(this.db);
      const owner = await this.#resolveOwner(auth, repos);
      const conversation = await repos.conversations.getById(
        conversationId,
        owner,
      );
      if (!conversation || isArchived(conversation)) {
        throw new OwnerScopedNotFoundError('Conversation not found', {
          resource: 'conversations',
          id: conversationId,
        });
      }
      selectedAgentId = conversation.agentId;
    }

    let parents = null;
    let lastRace = null;
    for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt += 1) {
      try {
        parents = await this.tx.run(async (trx) => {
          const repos = this.createRepositories(trx);
          const provisioner = new RunParentProvisioner(
            {
              organizations: repos.organizations,
              externalRefs: repos.externalRefs,
              catalog: repos.catalog,
              conversations: repos.conversations,
              sessions: repos.sessions,
            },
            {
              generateId: this.generateId,
              now: this.now,
              db: trx,
            },
          );
          const provisioned = await provisioner.provision(
            {
              ...auth,
              externalConversationId: conversationId,
            },
            { agentId: selectedAgentId },
          );
          if (provisioned.created.conversation) {
            await repos.conversations.updateMeta(
              provisioned.conversationId,
              { orgId: provisioned.orgId, userId: provisioned.userId },
              { title: 'New chat' },
            );
            await repos.externalRefs.getOrCreateConversationRef({
              orgId: provisioned.orgId,
              userId: provisioned.userId,
              provider: auth.provider || 'bff',
              externalSubject: provisioned.conversationId,
              conversationId: provisioned.conversationId,
            });
          }
          return provisioned;
        });
        break;
      } catch (err) {
        if (!(err instanceof ParentProvisioningRaceError)) throw err;
        lastRace = err;
      }
    }
    if (!parents) throw lastRace || new ParentProvisioningRaceError();

    const provisioned = await this.sessionProvisioner.ensure({
      orgId: parents.orgId,
      userId: parents.userId,
      conversationId: parents.conversationId,
      agentSessionId: parents.agentSessionId,
      sandboxSessionId: parents.sandboxSessionId,
      workspaceId: parents.workspaceId,
      traceId: input.traceId,
    });
    return {
      conversation_id: parents.conversationId,
      session_id: parents.sandboxSessionId,
      sandbox_session_id: parents.sandboxSessionId,
      agent_session_id: parents.agentSessionId,
      workspace_id: parents.workspaceId,
      reused_session: parents.created.session !== true,
      status: provisioned.status,
    };
  }

  /**
   * Resolve a Sandbox session for a trusted external principal. The returned
   * owner ids are internal ULIDs and are intended only for the BFF-to-Sandbox
   * server hop; callers must not expose them to browsers or A2A clients.
   *
   * @param {{ provider?: string, externalOrgId: string, externalUserId: string }} auth
   * @param {string} sandboxSessionId
   */
  async resolveSandboxSession(auth, sandboxSessionId) {
    if (!isUlid(sandboxSessionId)) {
      throw new ValidationError('sandboxSessionId must be a ULID');
    }
    const repos = this.createRepositories(this.db);
    const owner = await this.#resolveOwner(auth, repos);
    const row = await repos.sessions.getBySandboxSessionId(
      assertUlid(sandboxSessionId, 'sandboxSessionId'),
      owner,
    );
    if (!row) {
      throw new OwnerScopedNotFoundError('Sandbox session not found', {
        resource: 'agent_sessions',
        id: sandboxSessionId,
      });
    }
    return {
      session_id: row.sandboxSessionId,
      sandbox_session_id: row.sandboxSessionId,
      agent_session_id: row.agentSessionId,
      conversation_id: row.conversationId,
      workspace_id: row.workspaceId,
      org_id: owner.orgId,
      user_id: owner.userId,
      status: row.status,
      execution_fence_token: row.executionFenceToken,
    };
  }
}
