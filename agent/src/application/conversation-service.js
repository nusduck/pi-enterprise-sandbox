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

/**
 * Extract display text from messages.content_json for browser transcript.
 * Skips pi_journal_* system rows; surfaces user turns and assistant text.
 */
export function presentTranscriptMessage(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const role = String(msg.role || '').toLowerCase();
  if (role !== 'user' && role !== 'assistant') return null;
  const messageType = String(msg.messageType || msg.message_type || '').toLowerCase();
  if (messageType.startsWith('pi_journal')) return null;

  const content = msg.contentJson ?? msg.content_json ?? {};
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (content && typeof content === 'object') {
    if (typeof content.text === 'string') {
      text = content.text;
    } else if (Array.isArray(content.messages)) {
      // Legacy create-run rows only have the full prompt context. The current
      // turn is its last user item, not the first historic item.
      const current = [...content.messages]
        .reverse()
        .find((m) => m && typeof m === 'object' &&
          (m.role === 'user' || m.role == null));
      if (current) {
        if (typeof current.content === 'string') text = current.content;
        else if (Array.isArray(current.content)) {
          text = current.content
            .map((p) =>
              typeof p === 'string'
                ? p
                : p && typeof p === 'object' && typeof p.text === 'string'
                  ? p.text
                  : '',
            )
            .filter(Boolean)
            .join('');
        }
      }
    } else if (Array.isArray(content.content)) {
      text = content.content
        .map((p) =>
          typeof p === 'string'
            ? p
            : p && typeof p === 'object' && typeof p.text === 'string'
              ? p.text
              : '',
        )
        .filter(Boolean)
        .join('');
    }
  }
  // Empty assistant placeholders (tool-only turns) still surface as empty bubbles
  // only when we have no text; skip pure empty assistant rows without content.
  if (role === 'assistant' && !String(text || '').trim()) return null;

  const sequenceNo = msg.sequenceNo ?? msg.sequence_no;
  return {
    // Keep the durable message identity and ordering fields intact.  The
    // browser transcript is a projection of the append-only messages table,
    // not a new source of ordering truth.
    id: msg.messageId || msg.message_id || null,
    message_id: msg.messageId || msg.message_id || null,
    run_id: msg.runId || msg.run_id || null,
    role,
    content: [{ type: 'text', text: String(text || '') }],
    sequence_no: sequenceNo != null && Number.isFinite(Number(sequenceNo))
      ? Number(sequenceNo)
      : null,
    created_at: msg.createdAt || msg.created_at || null,
  };
}

/**
 * Present a conversation row for browser/BFF consumption.
 *
 * `session` is the current AgentSession when known. Browsers need
 * sandbox_session_id for dataset/artifact list/upload; leaving it null
 * forces every `/api/conversations/:id/datasets` call to 400/404.
 *
 * @param {object} row
 * @param {object[]} [messages]
 * @param {{ sandboxSessionId?: string|null, workspaceId?: string|null, agentSessionId?: string|null } | null} [session]
 */
export function presentConversation(row, messages = [], session = null) {
  const transcript = Array.isArray(messages)
    ? messages.map(presentTranscriptMessage).filter(Boolean)
    : [];
  const agentSessionId =
    session?.agentSessionId ?? row.currentAgentSessionId ?? null;
  const sandboxSessionId =
    session?.sandboxSessionId ??
    row.sandboxSessionId ??
    row.sandbox_session_id ??
    null;
  const workspaceId =
    session?.workspaceId ?? row.workspaceId ?? row.workspace_id ?? null;
  return {
    id: row.conversationId,
    title: row.title || 'New chat',
    sandbox_session_id: sandboxSessionId,
    agent_session_id: agentSessionId,
    workspace_id: workspaceId,
    messages: transcript,
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

  /**
   * Resolve the current AgentSession for a conversation when the pointer is set.
   * Best-effort: list/get still succeed if the session row is missing.
   *
   * @param {object} repos
   * @param {object} row conversation row
   * @param {{ orgId: string, userId: string }} owner
   */
  async #sessionForConversation(repos, row, owner) {
    const agentSessionId = row?.currentAgentSessionId ?? null;
    if (!agentSessionId || typeof repos.sessions?.getById !== 'function') {
      return null;
    }
    try {
      return await repos.sessions.getById(agentSessionId, owner);
    } catch {
      return null;
    }
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
    const presented = [];
    for (const row of rows) {
      const session = await this.#sessionForConversation(repos, row, owner);
      presented.push(presentConversation(row, [], session));
    }
    return presented;
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
    // Browser refresh uses GET conversation.messages as the durable transcript
    // floor (event rehydrate still supplies tools/process/artifacts).
    let messages = [];
    try {
      if (typeof repos.messages?.listByConversation === 'function') {
        messages = await repos.messages.listByConversation(id, owner, {
          limit: 500,
        });
      }
    } catch {
      messages = [];
    }
    const session = await this.#sessionForConversation(repos, row, owner);
    return presentConversation(row, messages, session);
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
          // Provisioner allocates logical sandbox/workspace ULIDs with the
          // AgentSession; surface them so FE dataset/artifact paths work
          // immediately after create (not only after refresh + ensure).
          return presentConversation(row, [], {
            agentSessionId:
              parents.agentSessionId ?? row.currentAgentSessionId ?? null,
            sandboxSessionId: parents.sandboxSessionId ?? null,
            workspaceId: parents.workspaceId ?? null,
          });
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
