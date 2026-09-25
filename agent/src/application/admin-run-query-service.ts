/**
 * 管理端的 Run 查询：全组织的运行列表、统计、详情、事件与工具台账。
 *
 * 三条约束（AGENTS.md §2）在这一层落实，而不是交给 handler 或 BFF：
 * - **fail-closed 的角色判定**：要求 `role === 'admin'`；BFF 没解析出角色（null）
 *   时拒绝，不回退到「默认允许」。
 * - **只限本 org**：org 由调用者的外部身份解析出来，所有查询都带 `org_id`。
 * - **跨 org 一律 404**：别的 org 的 runId 与不存在的 runId 返回同一个错误。
 */
import {
  AdminRoleRequiredError,
  OwnerScopedNotFoundError,
  ValidationError,
} from './errors.js';
import { ExternalIdentityResolver, type ExternalAuth } from './parent/external-identity-resolver.js';
import { ALL_RUN_STATUSES } from '../domain/run/run-status.js';
import { isUlid } from '../domain/shared/ulid.js';
import {
  AdminRunReadRepository,
  type AdminRunRow,
  type AdminRunStatRow,
} from '../infrastructure/mysql/repositories/admin-run-read-repository.js';

type Loose = any;

export interface AdminAuth extends ExternalAuth {
  role?: string | null;
}

export const ADMIN_RUN_LIST_DEFAULT_LIMIT = 50;
export const ADMIN_RUN_LIST_MAX_LIMIT = 200;
const EVENTS_MAX_LIMIT = 2000;
const DAY_MS = 86_400_000;

/** Status groups the UI filters by; values are plan §10 statuses. */
const STATUS_GROUPS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  running: ['ACCEPTED', 'QUEUED', 'STARTING', 'RUNNING', 'RETRYING', 'CANCELLING'],
  waiting: ['WAITING_APPROVAL', 'WAITING_INPUT'],
  failed: ['FAILED'],
  completed: ['SUCCEEDED', 'CANCELLED'],
});

export interface AdminRunListQuery {
  status?: string | null;
  agentId?: string | null;
  userId?: string | null;
  from?: string | null;
  to?: string | null;
  q?: string | null;
  cursor?: string | null;
  limit?: number | string | null;
}

function parseInstant(value: string | null | undefined, field: string): Date | null {
  if (value == null || value === '') return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new ValidationError(`${field} must be an ISO-8601 instant`);
  return new Date(ms);
}

function parseLimit(value: unknown): number {
  if (value == null || value === '') return ADMIN_RUN_LIST_DEFAULT_LIMIT;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > ADMIN_RUN_LIST_MAX_LIMIT) {
    throw new ValidationError(`limit must be an integer between 1 and ${ADMIN_RUN_LIST_MAX_LIMIT}`);
  }
  return n;
}

/** `status` accepts a group name (running / waiting / failed / completed) or plan §10 statuses, comma separated. */
export function parseStatusFilter(value: string | null | undefined): string[] {
  if (!value) return [];
  const out = new Set<string>();
  for (const raw of value.split(',')) {
    const token = raw.trim();
    if (!token) continue;
    const group = STATUS_GROUPS[token.toLowerCase()];
    if (group) group.forEach((s) => out.add(s));
    else if ((ALL_RUN_STATUSES as readonly string[]).includes(token.toUpperCase())) out.add(token.toUpperCase());
    else throw new ValidationError(`unknown status: ${token}`);
  }
  return [...out];
}

export function encodeCursor(row: Pick<AdminRunRow, 'createdAt' | 'runId'>): string | null {
  if (!row.createdAt) return null;
  return Buffer.from(`${row.createdAt}|${row.runId}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | null | undefined): { createdAt: string; runId: string } | null {
  if (!cursor) return null;
  const [createdAt, runId] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (!createdAt || Number.isNaN(Date.parse(createdAt)) || !isUlid(runId)) {
    throw new ValidationError('cursor is invalid');
  }
  return { createdAt, runId };
}

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

export interface AdminRunStats {
  day_start: string;
  today: number;
  yesterday: number;
  failed_today: number;
  failure_rate: number | null;
  waiting: number;
  longest_wait_ms: number | null;
  median_ms: number | null;
  p95_ms: number | null;
  /** Runs per day for the last 7 days, oldest first, ending today. */
  last_7_days: number[];
  /** True when the 7-day window hit the row cap and numbers are a lower bound. */
  truncated: boolean;
}

/**
 * Numbers for the admin stats strip. `dayStart` is the caller's local
 * midnight, so "today" matches what the admin sees on the clock.
 */
export function computeRunStats(
  rows: readonly AdminRunStatRow[],
  waiting: readonly AdminRunStatRow[],
  dayStart: Date,
  now: Date,
  truncated = false,
): AdminRunStats {
  const today0 = dayStart.getTime();
  const yesterday0 = today0 - DAY_MS;
  const last7 = Array.from({ length: 7 }, () => 0);
  let today = 0;
  let yesterday = 0;
  let failedToday = 0;
  const durations: number[] = [];
  for (const r of rows) {
    const t = Date.parse(r.createdAt || '');
    if (Number.isNaN(t)) continue;
    if (t >= today0) {
      today += 1;
      if (r.status === 'FAILED') failedToday += 1;
    } else if (t >= yesterday0) yesterday += 1;
    const day = t >= today0 ? 0 : Math.ceil((today0 - t) / DAY_MS);
    if (day >= 0 && day < 7) last7[6 - day] += 1;
    const s = Date.parse(r.startedAt || '');
    const e = Date.parse(r.completedAt || '');
    if (!Number.isNaN(s) && !Number.isNaN(e) && e >= s) durations.push(e - s);
  }
  durations.sort((a, b) => a - b);
  let longest: number | null = null;
  for (const r of waiting) {
    const since = Date.parse(r.updatedAt || r.startedAt || '');
    if (!Number.isNaN(since)) longest = Math.max(longest ?? 0, now.getTime() - since);
  }
  return {
    day_start: dayStart.toISOString(),
    today,
    yesterday,
    failed_today: failedToday,
    failure_rate: today ? failedToday / today : null,
    waiting: waiting.length,
    longest_wait_ms: longest,
    median_ms: percentile(durations, 50),
    p95_ms: percentile(durations, 95),
    last_7_days: last7,
    truncated,
  };
}

export function presentAdminRun(row: AdminRunRow): Record<string, unknown> {
  return {
    run_id: row.runId,
    status: row.status,
    status_reason: row.statusReason,
    source: row.source,
    user_id: row.userId,
    user_name: row.userName,
    conversation_id: row.conversationId,
    conversation_title: row.conversationTitle,
    agent_id: row.agentId,
    agent_name: row.agentName,
    agent_version_id: row.agentVersionId,
    agent_version_no: row.agentVersionNo,
    model_id: row.modelId,
    parent_run_id: row.parentRunId,
    trace_id: row.traceId,
    tool_count: row.toolCount,
    approval_count: row.approvalCount,
    user_input_excerpt: row.userInputExcerpt,
    turn_no: row.turnNo,
    created_at: row.createdAt,
    started_at: row.startedAt,
    completed_at: row.completedAt,
    finished_at: row.completedAt,
    updated_at: row.updatedAt,
  };
}

export class AdminRunQueryService {
  readonly read: AdminRunReadRepository;
  readonly resolveOrgId: (auth: AdminAuth) => Promise<string>;
  readonly now: () => Date;

  constructor(deps: {
    db?: Loose;
    createRepositories?: (db: Loose) => Loose;
    /** Tests inject these two; production derives them from db. */
    readRepository?: AdminRunReadRepository;
    resolveOrgId?: (auth: AdminAuth) => Promise<string>;
    now?: () => Date;
  }) {
    if (!deps.readRepository && !deps.db) throw new Error('AdminRunQueryService requires db');
    this.read = deps.readRepository ?? new AdminRunReadRepository(deps.db);
    if (deps.resolveOrgId) {
      this.resolveOrgId = deps.resolveOrgId;
    } else {
      if (typeof deps.createRepositories !== 'function') {
        throw new Error('AdminRunQueryService requires createRepositories');
      }
      const createRepositories = deps.createRepositories;
      const db = deps.db;
      this.resolveOrgId = async (auth) => {
        const repos = createRepositories(db);
        const resolver = new ExternalIdentityResolver({
          organizations: repos.organizations,
          externalRefs: repos.externalRefs,
        });
        return (await resolver.resolveOwner(auth)).orgId;
      };
    }
    this.now = deps.now ?? (() => new Date());
  }

  /** 角色缺失即拒绝：null 说明 BFF 没解析出角色，放行等于把管理面开给所有人。 */
  async #adminOrg(auth: AdminAuth): Promise<string> {
    if (String(auth?.role || '').toLowerCase() !== 'admin') throw new AdminRoleRequiredError();
    return this.resolveOrgId(auth);
  }

  async #requireRun(orgId: string, runId: string): Promise<AdminRunRow> {
    const row = isUlid(runId) ? await this.read.getRun(orgId, runId) : null;
    if (!row) throw new OwnerScopedNotFoundError('Run not found', { resource: 'runs', id: String(runId) });
    return row;
  }

  async list(auth: AdminAuth, query: AdminRunListQuery = {}) {
    const orgId = await this.#adminOrg(auth);
    const limit = parseLimit(query.limit);
    for (const [field, value] of [['agent_id', query.agentId], ['user_id', query.userId]] as const) {
      if (value && !isUlid(value)) throw new ValidationError(`${field} must be a ULID`);
    }
    const q = query.q ? String(query.q).trim().slice(0, 200) : null;
    const rows = await this.read.listRuns(orgId, {
      statuses: parseStatusFilter(query.status),
      agentId: query.agentId || null,
      userId: query.userId || null,
      from: parseInstant(query.from, 'from'),
      to: parseInstant(query.to, 'to'),
      query: q || null,
      before: decodeCursor(query.cursor),
      limit: limit + 1,
    });
    const page = rows.slice(0, limit);
    return {
      runs: page.map(presentAdminRun),
      next_cursor: rows.length > limit ? encodeCursor(page[page.length - 1]) : null,
    };
  }

  async stats(auth: AdminAuth, query: { dayStart?: string | null } = {}) {
    const orgId = await this.#adminOrg(auth);
    const now = this.now();
    const dayStart = parseInstant(query.dayStart, 'day_start')
      ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    if (dayStart.getTime() > now.getTime() || now.getTime() - dayStart.getTime() > 2 * DAY_MS) {
      throw new ValidationError('day_start must be within the last two days');
    }
    const cap = 20_000;
    const { rows, waiting } = await this.read.listForStats(orgId, new Date(dayStart.getTime() - 6 * DAY_MS), cap);
    return computeRunStats(rows, waiting, dayStart, now, rows.length >= cap);
  }

  async get(auth: AdminAuth, runId: string) {
    const orgId = await this.#adminOrg(auth);
    const row = await this.#requireRun(orgId, runId);
    const userInput = await this.read.getTriggeringText(orgId, row.runId);
    return { ...presentAdminRun(row), user_input: userInput };
  }

  async events(auth: AdminAuth, runId: string, opts: { afterSequence?: unknown; limit?: unknown } = {}) {
    const orgId = await this.#adminOrg(auth);
    await this.#requireRun(orgId, runId);
    const after = opts.afterSequence == null || opts.afterSequence === '' ? 0 : Number(opts.afterSequence);
    const limit = opts.limit == null || opts.limit === '' ? 500 : Number(opts.limit);
    if (!Number.isInteger(after) || after < 0) throw new ValidationError('after_sequence must be a non-negative integer');
    if (!Number.isInteger(limit) || limit < 1 || limit > EVENTS_MAX_LIMIT) {
      throw new ValidationError(`limit must be an integer between 1 and ${EVENTS_MAX_LIMIT}`);
    }
    const rows = await this.read.listEvents(orgId, runId, { afterSequence: after, limit });
    return {
      events: rows.map((e: Loose) => ({
        run_id: e.runId,
        sequence: e.sequenceNo,
        event_id: e.eventId,
        type: e.eventType,
        schema_version: e.eventVersion,
        payload: e.payloadJson ?? {},
        created_at: e.createdAt,
      })),
    };
  }

  async tools(auth: AdminAuth, runId: string) {
    const orgId = await this.#adminOrg(auth);
    await this.#requireRun(orgId, runId);
    return { tools: await this.read.listTools(orgId, runId) };
  }

  /** `skill` tool calls per Skill over the last `days` days (1–90, default 7), org-wide. */
  async skillUsage(auth: AdminAuth, opts: { days?: unknown } = {}) {
    const orgId = await this.#adminOrg(auth);
    const days = opts.days == null || opts.days === '' ? 7 : Number(opts.days);
    if (!Number.isInteger(days) || days < 1 || days > 90) throw new ValidationError('days must be an integer between 1 and 90');
    const since = new Date(this.now().getTime() - days * DAY_MS);
    return { days, since: since.toISOString(), usage: await this.read.skillUsage(orgId, since) };
  }
}
