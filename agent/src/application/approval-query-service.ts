/** Owner-scoped approval list/detail queries backed by Agent MySQL. */

import { ExternalIdentityResolver } from './parent/external-identity-resolver.js';
import {
  OwnerScopedNotFoundError,
  ValidationError,
} from './errors.js';
import { NotFoundError } from '../infrastructure/mysql/errors.js';
import { isUlid } from '../domain/shared/ulid.js';
import { APPROVAL_LIST_DEFAULT_LIMIT } from '../infrastructure/mysql/repositories/approval-repository.js';
import { decodeKeysetCursor, encodeKeysetCursor, parseKeysetLimit } from './keyset-cursor.js';
import type { createRepositoryBundle } from '../bootstrap/container-env.js';

type Repos = ReturnType<typeof createRepositoryBundle>;

function publicStatus(status) {
  return String(status || '').toLowerCase();
}

/** @param {Record<string, unknown>} value */
function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
}

/** Present only fields already redacted before request_json persistence. */
export function presentApproval(approval) {
  const payload = objectOrEmpty(approval.requestJson);
  const decision = objectOrEmpty(payload.decision);
  const args = payload.argsSummary ?? null;
  return {
    id: approval.approvalId,
    approval_id: approval.approvalId,
    run_id: approval.runId,
    conversation_id: approval.conversationId ?? null,
    tool_execution_id: approval.toolExecutionId,
    tool_name:
      typeof payload.toolName === 'string' ? payload.toolName : null,
    status: publicStatus(approval.status),
    risk_level:
      typeof decision.riskLevel === 'string' ? decision.riskLevel : null,
    reason:
      approval.decisionReason ??
      (typeof decision.reason === 'string'
        ? decision.reason
        : typeof decision.reasonCode === 'string'
          ? decision.reasonCode
          : null),
    command:
      args && typeof args === 'object' && typeof args.command === 'string'
        ? args.command
        : null,
    arguments: args,
    payload,
    user_id: approval.requestedBy,
    created_at: approval.createdAt,
    expires_at: approval.expiresAt,
    decided_at: approval.decidedAt,
  };
}

export class ApprovalQueryService {
  // TS 要求类字段显式声明（JS 里它们只在构造器里赋值）。
  createRepositories: typeof createRepositoryBundle;
  db: Parameters<typeof createRepositoryBundle>[0];

  constructor(deps: { createRepositories: typeof createRepositoryBundle, db: Parameters<typeof createRepositoryBundle>[0] }) {
    if (typeof deps?.createRepositories !== 'function' || !deps.db) {
      throw new Error('ApprovalQueryService requires repositories and db');
    }
    this.createRepositories = deps.createRepositories;
    this.db = deps.db;
  }

  async #owner(auth, repos) {
    const resolver = new ExternalIdentityResolver({
      organizations: repos.organizations,
      externalRefs: repos.externalRefs,
    });
    return resolver.resolveOwner(auth);
  }

  /**
   * Owner-scoped page of approvals: `{ approvals, next_cursor }`（design
   * ui-polish §2.4）。
   *
   * 排序 `created_at desc, id desc` 由仓储保证；这里只做 limit/cursor 的形状
   * 校验与「多取一条」的翻页判断。游标不含身份——作用域仍是解析出的 owner。
   */
  async list(auth, opts: { status?: string | null; limit?: unknown; cursor?: unknown } = {}) {
    const limit = parseKeysetLimit(opts.limit, APPROVAL_LIST_DEFAULT_LIMIT);
    const before = decodeKeysetCursor(opts.cursor);
    const repos = this.createRepositories(this.db);
    let owner;
    try {
      owner = await this.#owner(auth, repos);
    } catch (err) {
      if (err instanceof OwnerScopedNotFoundError) {
        return { approvals: [], next_cursor: null };
      }
      throw err;
    }
    const rows = await repos.approvals.listForOwner(owner, {
      ...(opts.status != null ? { status: opts.status } : {}),
      limit: limit + 1,
      before,
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      approvals: page.map(presentApproval),
      next_cursor:
        rows.length > limit && last
          ? encodeKeysetCursor(last.createdAt, last.approvalId)
          : null,
    };
  }

  async get(approvalId, auth) {
    if (!isUlid(approvalId)) {
      throw new ValidationError('approvalId must be a ULID');
    }
    const repos = this.createRepositories(this.db);
    let owner;
    try {
      owner = await this.#owner(auth, repos);
    } catch (err) {
      if (err instanceof OwnerScopedNotFoundError) {
        throw new OwnerScopedNotFoundError('Approval not found', {
          resource: 'approvals',
          id: approvalId,
        });
      }
      throw err;
    }
    try {
      return presentApproval(await repos.approvals.getById(approvalId, owner));
    } catch (err) {
      if (err instanceof NotFoundError) {
        throw new OwnerScopedNotFoundError('Approval not found', {
          resource: 'approvals',
          id: approvalId,
        });
      }
      throw err;
    }
  }
}
