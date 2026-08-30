/**
 * Cron control plane and durable claim execution.
 *
 * The service owns no timer. Both the HTTP control plane and the worker's
 * scheduler call into it; the only actual work it starts is CreateRunService,
 * using a deterministic idempotency key for each scheduled instant.
 */

import { randomBytes } from 'node:crypto';
import { ExternalIdentityResolver } from './parent/external-identity-resolver.js';
import { OwnerScopedNotFoundError, ValidationError } from './errors.js';
import { assertUlid, isUlid } from '../domain/shared/ulid.js';
import {
  assertTimeZone,
  nextCronOccurrence,
  parseCronExpression,
  parseRunAt,
  toScheduleIso,
} from './cron-schedule.js';

/** 过渡期宽松类型：注入的依赖多数还是 JS 类，形状由各自的模块负责。 */
type Loose = any;

export const CRON_MISFIRE_POLICIES = Object.freeze(['skip', 'fire_once']);
export const CRON_CONCURRENCY_POLICIES = Object.freeze(['forbid', 'allow']);
export const CRON_SCHEDULE_TYPES = Object.freeze(['cron', 'once']);
export const DEFAULT_CRON_MISFIRE_GRACE_MS = 60_000;
export const DEFAULT_CRON_CLAIM_RETRY_MS = 120_000;

function requireString(value, field, max) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ValidationError(`${field} is required`);
  }
  const normalized = value.trim();
  if (normalized.length > max) {
    throw new ValidationError(`${field} exceeds max length ${max}`);
  }
  return normalized;
}

function optionalUlid(value, field) {
  if (value == null || value === '') return null;
  if (!isUlid(value)) throw new ValidationError(`${field} must be a ULID`);
  return assertUlid(value, field);
}

function requireChoice(value, field, allowed, fallback) {
  const normalized = String(value ?? fallback).trim().toLowerCase();
  if (!allowed.includes(normalized)) {
    throw new ValidationError(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return normalized;
}

function sanitizeError(error) {
  const message = error instanceof Error ? error.message : String(error || 'Unknown error');
  return message.replace(/[\u0000-\u001F\u007F]/g, ' ').slice(0, 1000) || 'Unknown error';
}

function traceId() {
  return randomBytes(16).toString('hex');
}

function executionIdempotencyKey(cronJobId, scheduledAt) {
  return `cron:${cronJobId}:${new Date(scheduledAt).toISOString()}`;
}

/** @param {object} job */
export function presentCronJob(job) {
  return {
    cron_job_id: job.cronJobId,
    id: job.cronJobId,
    agent_id: job.agentId,
    name: job.name,
    prompt: job.prompt,
    schedule_type: job.scheduleType,
    cron_expression: job.cronExpression,
    run_at: toScheduleIso(job.runAt),
    timezone: job.timezone,
    enabled: job.enabled,
    next_run_at: toScheduleIso(job.nextRunAt),
    last_run_at: toScheduleIso(job.lastRunAt),
    misfire_policy: job.misfirePolicy,
    concurrency_policy: job.concurrencyPolicy,
    created_at: toScheduleIso(job.createdAt),
    updated_at: toScheduleIso(job.updatedAt),
  };
}

/** @param {object} execution */
export function presentCronJobRun(execution) {
  return {
    cron_job_run_id: execution.cronJobRunId,
    id: execution.cronJobRunId,
    cron_job_id: execution.cronJobId,
    scheduled_at: toScheduleIso(execution.scheduledAt),
    claimed_at: toScheduleIso(execution.claimedAt),
    run_id: execution.runId,
    status: execution.status,
    run_status: execution.runStatus ?? null,
    idempotency_key: execution.idempotencyKey,
    error_message: execution.errorMessage,
    created_at: toScheduleIso(execution.createdAt),
    updated_at: toScheduleIso(execution.updatedAt),
  };
}

export class CronJobService {
  // TS 要求类字段显式声明（JS 里它们只在构造器里赋值）。
  tx: Loose;
  createRepositories: Loose;
  db: Loose;
  createRunService: Loose;
  generateId: Loose;
  now: Loose;
  misfireGraceMs: Loose;

  /**
   * @param {{
   *   transactionManager: { run: Function },
   *   createRepositories: Function,
   *   db: any,
   *   createRunService: { execute: Function },
   *   generateId: () => string,
   *   now?: () => Date,
   *   misfireGraceMs?: number,
   * }} deps
   */
  constructor(deps: { transactionManager: { run: Function }, createRepositories: Function, db: any, createRunService: { execute: Function }, generateId: () => string, now?: () => Date, misfireGraceMs?: number, }) {
    if (!deps?.transactionManager?.run || typeof deps.createRepositories !== 'function') {
      throw new Error('CronJobService requires transactionManager and createRepositories');
    }
    if (!deps.db || !deps.createRunService?.execute || typeof deps.generateId !== 'function') {
      throw new Error('CronJobService requires db, createRunService, and generateId');
    }
    this.tx = deps.transactionManager;
    this.createRepositories = deps.createRepositories;
    this.db = deps.db;
    this.createRunService = deps.createRunService;
    this.generateId = deps.generateId;
    this.now = deps.now ?? (() => new Date());
    this.misfireGraceMs = deps.misfireGraceMs ?? DEFAULT_CRON_MISFIRE_GRACE_MS;
  }

  async #resolveOwner(auth, repos = this.createRepositories(this.db)) {
    const resolver = new ExternalIdentityResolver({
      organizations: repos.organizations,
      externalRefs: repos.externalRefs,
    });
    return resolver.resolveOwner(auth);
  }

  async #assertAgentForOwner(agentId, owner, repos) {
    if (!agentId) return null;
    const definition = await repos.catalog.getDefinitionById(agentId);
    if (!definition || definition.orgId !== owner.orgId || String(definition.status).toLowerCase() !== 'active') {
      throw new ValidationError('Selected agent is not active for this organization');
    }
    return agentId;
  }

  #normalizeInput(input, existing = null) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new ValidationError('Cron job body must be an object');
    }
    const scheduleType = requireChoice(
      input.scheduleType ?? input.schedule_type ?? existing?.scheduleType,
      'scheduleType',
      CRON_SCHEDULE_TYPES,
      'cron',
    );
    const timezone = assertTimeZone(input.timezone ?? existing?.timezone ?? 'UTC');
    const misfirePolicy = requireChoice(
      input.misfirePolicy ?? input.misfire_policy ?? existing?.misfirePolicy,
      'misfirePolicy',
      CRON_MISFIRE_POLICIES,
      'fire_once',
    );
    const concurrencyPolicy = requireChoice(
      input.concurrencyPolicy ?? input.concurrency_policy ?? existing?.concurrencyPolicy,
      'concurrencyPolicy',
      CRON_CONCURRENCY_POLICIES,
      'forbid',
    );
    const enabled = input.enabled == null ? existing?.enabled ?? true : Boolean(input.enabled);
    const agentId = optionalUlid(
      input.agentId ?? input.agent_id ?? existing?.agentId,
      'agentId',
    );
    const name = requireString(input.name ?? existing?.name, 'name', 255);
    const prompt = requireString(input.prompt ?? existing?.prompt, 'prompt', 50_000);

    let cronExpression = null;
    let runAt = null;
    if (scheduleType === 'cron') {
      const parsed = parseCronExpression(
        input.cronExpression ?? input.cron_expression ?? existing?.cronExpression,
      );
      cronExpression = parsed.expression;
    } else {
      runAt = parseRunAt(input.runAt ?? input.run_at ?? existing?.runAt);
    }

    const now = this.now();
    const nextRunAt = !enabled
      ? null
      : scheduleType === 'cron'
        ? nextCronOccurrence(cronExpression, timezone, now)
        : runAt;
    return {
      name,
      prompt,
      scheduleType,
      cronExpression,
      runAt,
      timezone,
      enabled,
      nextRunAt,
      misfirePolicy,
      concurrencyPolicy,
      agentId,
    };
  }

  async list(auth, opts = {}) {
    const repos = this.createRepositories(this.db);
    try {
      const owner = await this.#resolveOwner(auth, repos);
      const jobs = await repos.cronJobs.listForOwner(owner, opts);
      return jobs.map(presentCronJob);
    } catch (error) {
      // A trusted identity without any Runs has no provisioned owner yet.
      if (error instanceof OwnerScopedNotFoundError) return [];
      throw error;
    }
  }

  async get(cronJobId, auth) {
    const repos = this.createRepositories(this.db);
    const owner = await this.#resolveOwner(auth, repos);
    return presentCronJob(await repos.cronJobs.requireById(cronJobId, owner));
  }

  async create(auth, input) {
    const normalized = this.#normalizeInput(input);
    return this.tx.run(async (trx) => {
      const repos = this.createRepositories(trx);
      const owner = await this.#resolveOwner(auth, repos);
      await this.#assertAgentForOwner(normalized.agentId, owner, repos);
      const job = await repos.cronJobs.create({
        cronJobId: assertUlid(this.generateId(), 'cronJobId'),
        orgId: owner.orgId,
        userId: owner.userId,
        ...normalized,
        authProvider: requireString(auth.provider || 'bff', 'provider', 64),
        externalOrgId: requireString(auth.externalOrgId, 'externalOrgId', 255),
        externalUserId: requireString(auth.externalUserId, 'externalUserId', 255),
      });
      return presentCronJob(job);
    });
  }

  async update(cronJobId, auth, input) {
    return this.tx.run(async (trx) => {
      const repos = this.createRepositories(trx);
      const owner = await this.#resolveOwner(auth, repos);
      const existing = await repos.cronJobs.requireById(cronJobId, owner, { forUpdate: true });
      const normalized = this.#normalizeInput(input, existing);
      await this.#assertAgentForOwner(normalized.agentId, owner, repos);
      const job = await repos.cronJobs.update(cronJobId, owner, normalized);
      return presentCronJob(job);
    });
  }

  async delete(cronJobId, auth) {
    return this.tx.run(async (trx) => {
      const repos = this.createRepositories(trx);
      const owner = await this.#resolveOwner(auth, repos);
      await repos.cronJobs.softDelete(cronJobId, owner);
    });
  }

  async listRuns(cronJobId, auth, opts = {}) {
    const repos = this.createRepositories(this.db);
    const owner = await this.#resolveOwner(auth, repos);
    const entries = await repos.cronJobs.listRunsForJob(cronJobId, owner, opts);
    return entries.map(presentCronJobRun);
  }

  #nextAfter(job, scheduledAt) {
    if (job.scheduleType === 'once') return null;
    return nextCronOccurrence(job.cronExpression, job.timezone, new Date(scheduledAt));
  }

  /**
   * Claim due schedules atomically. The later Run creation is deliberately
   * outside this transaction; its deterministic key makes a post-commit crash
   * recoverable without creating a second Agent Run.
   */
  async claimDue(limit = 25) {
    const now = this.now();
    const claims = [];
    await this.tx.run(async (trx) => {
      const repos = this.createRepositories(trx);
      const due = await repos.cronJobs.listDueForUpdate(now, limit);
      for (const job of due) {
        const scheduledAt = new Date(job.nextRunAt);
        const nextRunAt = this.#nextAfter(job, scheduledAt);
        const onceFinished = job.scheduleType === 'once';
        const missed = now.getTime() - scheduledAt.getTime() > this.misfireGraceMs;
        const shouldSkip = missed && job.misfirePolicy === 'skip';
        const blocked =
          !shouldSkip &&
          job.concurrencyPolicy === 'forbid' &&
          (await repos.cronJobs.hasOpenExecution(job.cronJobId));
        const status = shouldSkip || blocked ? 'SKIPPED' : 'CLAIMED';
        const reason = shouldSkip
          ? 'MISFIRE_SKIPPED'
          : blocked
            ? 'CONCURRENCY_FORBID'
            : null;
        const execution = await repos.cronJobs.createExecutionClaim({
          cronJobRunId: assertUlid(this.generateId(), 'cronJobRunId'),
          cronJobId: job.cronJobId,
          scheduledAt,
          claimedAt: now,
          status,
          idempotencyKey: executionIdempotencyKey(job.cronJobId, scheduledAt),
          errorMessage: reason,
        });
        // A unique (job, scheduled_at) conflict means another worker won.
        if (!execution) continue;
        await repos.cronJobs.updateScheduleState(job.cronJobId, {
          nextRunAt,
          lastRunAt: scheduledAt,
          enabled: onceFinished ? false : job.enabled,
        });
        if (status === 'CLAIMED') claims.push({ job, execution });
      }
    });
    return claims;
  }

  async runManual(cronJobId, auth) {
    const now = this.now();
    const claimed = await this.tx.run(async (trx) => {
      const repos = this.createRepositories(trx);
      const owner = await this.#resolveOwner(auth, repos);
      const job = await repos.cronJobs.requireById(cronJobId, owner, { forUpdate: true });
      if (job.concurrencyPolicy === 'forbid' && await repos.cronJobs.hasOpenExecution(job.cronJobId)) {
        throw new ValidationError('Cron job already has an active execution');
      }
      const execution = await repos.cronJobs.createExecutionClaim({
        cronJobRunId: assertUlid(this.generateId(), 'cronJobRunId'),
        cronJobId: job.cronJobId,
        scheduledAt: now,
        claimedAt: now,
        status: 'CLAIMED',
        idempotencyKey: executionIdempotencyKey(job.cronJobId, now),
      });
      if (!execution) throw new ValidationError('Duplicate manual execution; retry');
      return { job, execution };
    });
    return presentCronJobRun(await this.executeClaim(claimed));
  }

  async executeClaim({ job, execution }) {
    try {
      // Current authorization is checked again at execution time. This makes
      // a disabled user/membership or inactive selected Agent fail closed.
      const repos = this.createRepositories(this.db);
      const user = await repos.organizations.getUser(job.userId);
      const membership = await repos.organizations.getMembership({
        orgId: job.orgId,
        userId: job.userId,
      });
      if (!user || String(user.status).toLowerCase() !== 'active' || !membership || String(membership.status).toLowerCase() !== 'active') {
        throw new ValidationError('Cron job owner is no longer active');
      }
      if (job.agentId) await this.#assertAgentForOwner(job.agentId, job, repos);
      const result = await this.createRunService.execute({
        messages: [{ role: 'user', content: job.prompt }],
        auth: {
          provider: job.authProvider,
          externalOrgId: job.externalOrgId,
          externalUserId: job.externalUserId,
        },
        traceId: traceId(),
        idempotencyKey: execution.idempotencyKey,
        agentId: job.agentId,
      });
      await this.tx.run(async (trx) => {
        await this.createRepositories(trx).cronJobs.updateExecution(execution.cronJobRunId, {
          runId: result.runId,
          status: 'QUEUED',
          errorMessage: result.queueWarning || null,
        });
      });
    } catch (error) {
      await this.tx.run(async (trx) => {
        await this.createRepositories(trx).cronJobs.updateExecution(execution.cronJobRunId, {
          status: 'FAILED',
          errorMessage: sanitizeError(error),
        });
      });
    }
    return this.createRepositories(this.db).cronJobs.getExecution(execution.cronJobRunId);
  }

  async recoverClaims(before, limit = 25) {
    const stale = await this.createRepositories(this.db).cronJobs.listStaleClaims(before, limit);
    const results = [];
    for (const item of stale) results.push(await this.executeClaim(item));
    return results.filter(Boolean);
  }

  async reconcileRuns(limit = 100) {
    const repos = this.createRepositories(this.db);
    const executions = await repos.cronJobs.listNonterminalExecutions(limit);
    for (const execution of executions) {
      const runStatus = String(execution.runStatus || '').toUpperCase();
      const terminal = {
        SUCCEEDED: 'SUCCEEDED',
        CANCELLED: 'CANCELLED',
        FAILED: 'FAILED',
        CRASHED: 'FAILED',
      }[runStatus];
      if (!terminal) continue;
      await repos.cronJobs.updateExecution(execution.cronJobRunId, {
        status: terminal,
        errorMessage: terminal === 'FAILED' ? `Agent run ${runStatus}` : null,
      });
    }
  }
}

/** Timer wrapper used only by agent-worker, never by a browser or Extension. */
export class CronScheduler {
  // TS 要求类字段显式声明（JS 里它们只在构造器里赋值）。
  service: Loose;
  now: Loose;
  intervalMs: Loose;
  claimRetryMs: Loose;
  batchSize: Loose;
  logger: Loose;
  timer: Loose;
  running: boolean;
  started: boolean;

  /** @param {{ cronJobService: CronJobService, now?: () => Date, intervalMs?: number, claimRetryMs?: number, batchSize?: number, logger?: Console }} deps */
  constructor(deps) {
    if (!deps?.cronJobService) throw new Error('CronScheduler requires cronJobService');
    this.service = deps.cronJobService;
    this.now = deps.now ?? (() => new Date());
    this.intervalMs = Math.max(10_000, Number(deps.intervalMs) || 30_000);
    this.claimRetryMs = Math.max(10_000, Number(deps.claimRetryMs) || DEFAULT_CRON_CLAIM_RETRY_MS);
    this.batchSize = Math.max(1, Math.min(200, Number(deps.batchSize) || 25));
    this.logger = deps.logger ?? console;
    this.timer = null;
    this.running = false;
    this.started = false;
  }

  async tick() {
    if (this.running) return { skipped: true, claims: 0 };
    this.running = true;
    try {
      await this.service.reconcileRuns(this.batchSize * 4);
      await this.service.recoverClaims(
        new Date(this.now().getTime() - this.claimRetryMs),
        this.batchSize,
      );
      const claims = await this.service.claimDue(this.batchSize);
      for (const claim of claims) await this.service.executeClaim(claim);
      return { skipped: false, claims: claims.length };
    } finally {
      this.running = false;
    }
  }

  async start() {
    if (this.started) return;
    this.started = true;
    try {
      await this.tick();
    } catch (error) {
      this.logger.error('[cron-scheduler] initial tick failed:', sanitizeError(error));
    }
    this.timer = setInterval(() => {
      void this.tick().catch((error) => {
        this.logger.error('[cron-scheduler] tick failed:', sanitizeError(error));
      });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  async shutdown() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.started = false;
  }
}
