/** Durable owner-scoped Cron job repositories. */

import { applyOwnerScope, requireOwnerScope } from '../ownership.js';
import { formatDateTime, toMysqlDateTime } from '../row-mappers.js';
import { NotFoundError } from '../errors.js';
import { assertUlid } from '../../../domain/shared/ulid.js';

/** 过渡期宽松类型：注入的依赖多数还是 JS 类，形状由各自的模块负责。 */
type Loose = any;

export const CRON_JOB_LIST_DEFAULT_LIMIT = 100;
export const CRON_JOB_RUN_LIST_DEFAULT_LIMIT = 50;
export const CRON_JOB_LIST_MAX_LIMIT = 200;

function requireLimit(value, fallback) {
  if (value == null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > CRON_JOB_LIST_MAX_LIMIT) {
    throw new Error(`limit must be an integer between 1 and ${CRON_JOB_LIST_MAX_LIMIT}`);
  }
  return n;
}

function requireOwner(input) {
  const raw = requireOwnerScope(input);
  return {
    orgId: assertUlid(raw.orgId, 'orgId'),
    userId: assertUlid(raw.userId, 'userId'),
  };
}

function mapCronJob(row) {
  return {
    cronJobId: String(row.cron_job_id),
    orgId: String(row.org_id),
    userId: String(row.user_id),
    agentId: row.agent_id == null ? null : String(row.agent_id),
    name: String(row.name),
    prompt: String(row.prompt),
    scheduleType: String(row.schedule_type),
    cronExpression: row.cron_expression == null ? null : String(row.cron_expression),
    runAt: formatDateTime(row.run_at),
    timezone: String(row.timezone),
    enabled: Boolean(row.enabled),
    nextRunAt: formatDateTime(row.next_run_at),
    lastRunAt: formatDateTime(row.last_run_at),
    misfirePolicy: String(row.misfire_policy),
    concurrencyPolicy: String(row.concurrency_policy),
    authProvider: String(row.auth_provider),
    externalOrgId: String(row.external_org_id),
    externalUserId: String(row.external_user_id),
    deletedAt: formatDateTime(row.deleted_at),
    createdAt: formatDateTime(row.created_at),
    updatedAt: formatDateTime(row.updated_at),
  };
}

function mapCronJobRun(row) {
  return {
    cronJobRunId: String(row.cron_job_run_id),
    cronJobId: String(row.cron_job_id),
    scheduledAt: formatDateTime(row.scheduled_at),
    claimedAt: formatDateTime(row.claimed_at),
    runId: row.run_id == null ? null : String(row.run_id),
    status: String(row.status),
    runStatus: row.run_status == null ? null : String(row.run_status),
    idempotencyKey: String(row.idempotency_key),
    errorMessage: row.error_message == null ? null : String(row.error_message),
    createdAt: formatDateTime(row.created_at),
    updatedAt: formatDateTime(row.updated_at),
  };
}

/** @param {unknown} error */
function isDuplicate(error) {
  return error?.code === 'ER_DUP_ENTRY' || error?.errno === 1062;
}

/** Owner-scoped 查询的租户边界。所有仓储方法都按它定位归属。 */
type OwnerScope = { orgId: string; userId: string };

export class CronJobRepository {
  // TS 要求类字段显式声明（JS 里它们只在构造器里赋值）。
  db: Loose;
  now: Loose;

  constructor(db: import('knex').Knex | import('knex').Knex.Transaction, opts: { now?: () => Date } = {}) {
    if (!db) throw new Error('CronJobRepository requires a knex executor');
    this.db = db;
    this.now = opts.now ?? (() => new Date());
  }

  async create(input) {
    const owner = requireOwner(input);
    const cronJobId = assertUlid(input.cronJobId, 'cronJobId');
    const now = toMysqlDateTime(input.createdAt || this.now());
    await this.db('cron_jobs').insert({
      cron_job_id: cronJobId,
      org_id: owner.orgId,
      user_id: owner.userId,
      agent_id: input.agentId == null ? null : assertUlid(input.agentId, 'agentId'),
      name: input.name,
      prompt: input.prompt,
      schedule_type: input.scheduleType,
      cron_expression: input.cronExpression ?? null,
      run_at: input.runAt == null ? null : toMysqlDateTime(input.runAt),
      timezone: input.timezone,
      enabled: input.enabled !== false,
      next_run_at: input.nextRunAt == null ? null : toMysqlDateTime(input.nextRunAt),
      last_run_at: input.lastRunAt == null ? null : toMysqlDateTime(input.lastRunAt),
      misfire_policy: input.misfirePolicy,
      concurrency_policy: input.concurrencyPolicy,
      auth_provider: input.authProvider,
      external_org_id: input.externalOrgId,
      external_user_id: input.externalUserId,
      deleted_at: null,
      created_at: now,
      updated_at: now,
    });
    return this.requireById(cronJobId, owner);
  }

  async getById(
    cronJobId: string,
    scope: OwnerScope,
    opts: { forUpdate?: boolean; includeDeleted?: boolean } = {},
  ) {
    const owner = requireOwner(scope);
    let query = applyOwnerScope(
      this.db('cron_jobs').where({ cron_job_id: assertUlid(cronJobId, 'cronJobId') }),
      owner,
    );
    if (opts.includeDeleted !== true) query = query.whereNull('deleted_at');
    if (opts.forUpdate) query = query.forUpdate();
    const row = await query.first();
    return row ? mapCronJob(row) : null;
  }

  async requireById(cronJobId, scope, opts = {}) {
    const job = await this.getById(cronJobId, scope, opts);
    if (!job) {
      throw new NotFoundError('Cron job not found', {
        resource: 'cron_jobs',
        id: cronJobId,
      });
    }
    return job;
  }

  async listForOwner(
    scope: OwnerScope,
    opts: { enabled?: boolean; limit?: number } = {},
  ) {
    const owner = requireOwner(scope);
    const limit = requireLimit(opts.limit, CRON_JOB_LIST_DEFAULT_LIMIT);
    let query = applyOwnerScope(this.db('cron_jobs'), owner).whereNull('deleted_at');
    if (opts.enabled != null) query = query.where({ enabled: Boolean(opts.enabled) });
    const rows = await query.orderBy('created_at', 'desc').limit(limit);
    return rows.map(mapCronJob);
  }

  async update(cronJobId, scope, patch) {
    const owner = requireOwner(scope);
    const update = { updated_at: toMysqlDateTime(this.now()) };
    const fields = {
      name: 'name',
      prompt: 'prompt',
      scheduleType: 'schedule_type',
      cronExpression: 'cron_expression',
      runAt: 'run_at',
      timezone: 'timezone',
      enabled: 'enabled',
      nextRunAt: 'next_run_at',
      lastRunAt: 'last_run_at',
      misfirePolicy: 'misfire_policy',
      concurrencyPolicy: 'concurrency_policy',
      agentId: 'agent_id',
    };
    for (const [key, column] of Object.entries(fields)) {
      if (!(key in patch)) continue;
      const value = patch[key];
      update[column] =
        key === 'runAt' || key === 'nextRunAt' || key === 'lastRunAt'
          ? value == null
            ? null
            : toMysqlDateTime(value)
          : key === 'agentId'
            ? value == null
              ? null
              : assertUlid(value, 'agentId')
            : value;
    }
    const count = await applyOwnerScope(
      this.db('cron_jobs')
        .where({ cron_job_id: assertUlid(cronJobId, 'cronJobId') })
        .whereNull('deleted_at'),
      owner,
    ).update(update);
    if (!count) {
      throw new NotFoundError('Cron job not found', {
        resource: 'cron_jobs',
        id: cronJobId,
      });
    }
    return this.requireById(cronJobId, owner);
  }

  /**
   * Scheduler-only state transition. Callers must already hold the job row
   * lock from listDueForUpdate / requireById(..., { forUpdate: true }).
   */
  async updateScheduleState(
    cronJobId: string,
    patch: { nextRunAt?: Date | string | null; lastRunAt?: Date | string | null; enabled?: boolean },
  ) {
    // 按列增量拼的 UPDATE 补丁：哪些列出现取决于 patch 里有哪些键，
    // 字面量推断不会带上没写出来的列。
    const update: Record<string, unknown> = {
      updated_at: toMysqlDateTime(this.now()),
    };
    if ('nextRunAt' in patch) {
      update.next_run_at = patch.nextRunAt == null ? null : toMysqlDateTime(patch.nextRunAt);
    }
    if ('lastRunAt' in patch) {
      update.last_run_at = patch.lastRunAt == null ? null : toMysqlDateTime(patch.lastRunAt);
    }
    if ('enabled' in patch) update.enabled = Boolean(patch.enabled);
    const count = await this.db('cron_jobs')
      .where({ cron_job_id: assertUlid(cronJobId, 'cronJobId') })
      .whereNull('deleted_at')
      .update(update);
    if (!count) {
      throw new NotFoundError('Cron job not found', {
        resource: 'cron_jobs',
        id: cronJobId,
      });
    }
  }

  async softDelete(cronJobId, scope) {
    const owner = requireOwner(scope);
    const now = toMysqlDateTime(this.now());
    const count = await applyOwnerScope(
      this.db('cron_jobs')
        .where({ cron_job_id: assertUlid(cronJobId, 'cronJobId') })
        .whereNull('deleted_at'),
      owner,
    ).update({ enabled: false, deleted_at: now, updated_at: now });
    if (!count) {
      throw new NotFoundError('Cron job not found', {
        resource: 'cron_jobs',
        id: cronJobId,
      });
    }
  }

  /** Lock due jobs inside a transaction. */
  async listDueForUpdate(now, limit) {
    const count = requireLimit(limit, 25);
    let query = this.db('cron_jobs')
      .where({ enabled: true })
      .whereNull('deleted_at')
      .whereNotNull('next_run_at')
      .where('next_run_at', '<=', toMysqlDateTime(now))
      .orderBy('next_run_at', 'asc')
      .limit(count)
      .forUpdate();
    // MySQL 8 supports SKIP LOCKED. Keep the call feature-detectable for
    // lightweight Knex fakes used by unit tests.
    if (typeof query.skipLocked === 'function') query = query.skipLocked();
    const rows = await query;
    return rows.map(mapCronJob);
  }

  async createExecutionClaim(input) {
    const now = toMysqlDateTime(input.createdAt || this.now());
    const row = {
      cron_job_run_id: assertUlid(input.cronJobRunId, 'cronJobRunId'),
      cron_job_id: assertUlid(input.cronJobId, 'cronJobId'),
      scheduled_at: toMysqlDateTime(input.scheduledAt),
      claimed_at: toMysqlDateTime(input.claimedAt || input.createdAt || this.now()),
      run_id: null,
      status: input.status || 'CLAIMED',
      idempotency_key: input.idempotencyKey,
      error_message: input.errorMessage ?? null,
      created_at: now,
      updated_at: now,
    };
    try {
      await this.db('cron_job_runs').insert(row);
      return mapCronJobRun(row);
    } catch (error) {
      if (!isDuplicate(error)) throw error;
      return null;
    }
  }

  async updateExecution(
    cronJobRunId: string,
    patch: { runId?: string | null; status?: string; errorMessage?: string | null },
  ) {
    const update: Record<string, unknown> = {
      updated_at: toMysqlDateTime(this.now()),
    };
    if ('runId' in patch) update.run_id = patch.runId == null ? null : assertUlid(patch.runId, 'runId');
    if ('status' in patch) update.status = patch.status;
    if ('errorMessage' in patch) update.error_message = patch.errorMessage ?? null;
    const count = await this.db('cron_job_runs')
      .where({ cron_job_run_id: assertUlid(cronJobRunId, 'cronJobRunId') })
      .update(update);
    if (!count) throw new NotFoundError('Cron job run not found', { resource: 'cron_job_runs', id: cronJobRunId });
  }

  async getExecution(cronJobRunId) {
    const row = await this.db('cron_job_runs')
      .where({ cron_job_run_id: assertUlid(cronJobRunId, 'cronJobRunId') })
      .first();
    return row ? mapCronJobRun(row) : null;
  }

  async listRunsForJob(
    cronJobId: string,
    scope: OwnerScope,
    opts: { limit?: number } = {},
  ) {
    const owner = requireOwner(scope);
    const limit = requireLimit(opts.limit, CRON_JOB_RUN_LIST_DEFAULT_LIMIT);
    const id = assertUlid(cronJobId, 'cronJobId');
    const rows = await this.db('cron_job_runs as jr')
      .join('cron_jobs as j', 'j.cron_job_id', 'jr.cron_job_id')
      .leftJoin('runs as r', 'r.run_id', 'jr.run_id')
      .select('jr.*', 'r.status as run_status')
      .where('jr.cron_job_id', id)
      .where('j.org_id', owner.orgId)
      .where('j.user_id', owner.userId)
      .orderBy('jr.scheduled_at', 'desc')
      .limit(limit);
    return rows.map(mapCronJobRun);
  }

  async hasOpenExecution(cronJobId) {
    const id = assertUlid(cronJobId, 'cronJobId');
    const row = await this.db('cron_job_runs as jr')
      .leftJoin('runs as r', 'r.run_id', 'jr.run_id')
      .where('jr.cron_job_id', id)
      .where((q) => {
        q.where('jr.status', 'CLAIMED').orWhere((nested) =>
          nested.whereIn('jr.status', ['QUEUED', 'RUNNING'])
            .where((runStatus) =>
              runStatus.whereNull('r.status').orWhereNotIn('r.status', [
                'SUCCEEDED', 'FAILED', 'CANCELLED', 'CRASHED',
              ]),
            ),
        );
      })
      .first('jr.cron_job_run_id');
    return Boolean(row);
  }

  async listStaleClaims(before, limit = 25) {
    const count = requireLimit(limit, 25);
    const rows = await this.db('cron_job_runs as jr')
      .join('cron_jobs as j', 'j.cron_job_id', 'jr.cron_job_id')
      .select('jr.*')
      .where('jr.status', 'CLAIMED')
      .where('jr.claimed_at', '<=', toMysqlDateTime(before))
      .whereNull('j.deleted_at')
      .orderBy('jr.claimed_at', 'asc')
      .limit(count);
    const claims = [];
    for (const row of rows) {
      const jobRow = await this.db('cron_jobs')
        .where({ cron_job_id: String(row.cron_job_id) })
        .whereNull('deleted_at')
        .first();
      if (jobRow) {
        claims.push({ job: mapCronJob(jobRow), execution: mapCronJobRun(row) });
      }
    }
    return claims;
  }

  async listNonterminalExecutions(limit = 100) {
    const count = requireLimit(limit, 100);
    const rows = await this.db('cron_job_runs as jr')
      .join('runs as r', 'r.run_id', 'jr.run_id')
      .select('jr.*', 'r.status as run_status')
      .whereIn('jr.status', ['QUEUED', 'RUNNING'])
      .orderBy('jr.updated_at', 'asc')
      .limit(count);
    return rows.map(mapCronJobRun);
  }
}

export { mapCronJob, mapCronJobRun };
