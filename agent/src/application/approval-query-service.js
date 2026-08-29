/** Owner-scoped approval list/detail queries backed by Agent MySQL. */

import { ExternalIdentityResolver } from './parent/external-identity-resolver.js';
import {
  OwnerScopedNotFoundError,
  ValidationError,
} from './errors.js';
import { NotFoundError } from '../infrastructure/mysql/errors.js';
import { isUlid } from '../domain/shared/ulid.js';

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
  // @ts-expect-error 未校验string传入闭合联合，运行时需窄化守卫，存活代码先用expect-error收敛 —— TS2345: Argument of type 'unknown' is not assignable to parameter of
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
      // @ts-expect-error 遗留JS占位类型object未展开，访问command需收窄，存活代码先用expect-error收敛 —— TS2339: Property 'command' does not exist on type 'object'.
      args && typeof args === 'object' && typeof args.command === 'string'
        // @ts-expect-error 遗留JS占位类型object未展开，访问command需收窄，存活代码先用expect-error收敛 —— TS2339: Property 'command' does not exist on type 'object'.
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
  /**
   * @param {{ createRepositories: (db: any) => any, db: any }} deps
   */
  constructor(deps) {
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

  async list(auth, opts = {}) {
    const repos = this.createRepositories(this.db);
    let owner;
    try {
      owner = await this.#owner(auth, repos);
    } catch (err) {
      if (err instanceof OwnerScopedNotFoundError) return [];
      throw err;
    }
    const rows = await repos.approvals.listForOwner(owner, opts);
    return rows.map(presentApproval);
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
