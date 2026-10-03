/**
 * 管理端的 Run 只读查询：**按 org 作用域**，不按 owner。
 *
 * 其余 Run 仓储都用 `applyOwnerScope`（org + user），管理员看全组织运行时不能复用
 * 它们。这里每条查询都以 `r.org_id = ?` 开头，调用方必须先完成角色判定与 org
 * 解析（见 `admin-run-query-service.ts`）；本类不做任何鉴权，也不对外暴露写操作。
 *
 * 行形状保持与 owner 面一致（事件走 `mapRunEvent`，工具走公共视图），BFF 与前端
 * 因此复用同一套解析。
 */
import { formatDateTime, mapRunEvent, toMysqlDateTime } from '../row-mappers.js';
import { parseJsonColumn, publicJsonView } from './tool-execution-repository.js';
import { assertUlid } from '../../../domain/shared/ulid.js';
import type { Knex } from 'knex';

export interface AdminRunFilters {
  statuses?: readonly string[];
  agentId?: string | null;
  userId?: string | null;
  from?: Date | null;
  to?: Date | null;
  query?: string | null;
  /** Keyset cursor: rows strictly older than (createdAt, runId). */
  before?: { createdAt: string; runId: string } | null;
  limit: number;
}

export interface AdminRunRow {
  runId: string;
  status: string;
  statusReason: string | null;
  source: string | null;
  userId: string;
  userName: string | null;
  conversationId: string | null;
  conversationTitle: string | null;
  agentId: string | null;
  agentName: string | null;
  agentVersionId: string | null;
  agentVersionNo: number | null;
  modelId: string | null;
  parentRunId: string | null;
  traceId: string | null;
  toolCount: number;
  approvalCount: number;
  /** First 200 characters of the user message that started the run, when stored as `{ text }`. */
  userInputExcerpt: string | null;
  /** 1-based position among the conversation's top-level runs; null for child runs. */
  turnNo: number | null;
  createdAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string | null;
}

export interface AdminRunStatRow {
  status: string;
  createdAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string | null;
}

function str(value: unknown): string | null {
  return value == null || value === '' ? null : String(value);
}

function mapAdminRun(row: Record<string, unknown>): AdminRunRow {
  return {
    runId: String(row.run_id),
    status: String(row.status),
    statusReason: str(row.status_reason),
    source: str(row.source),
    userId: String(row.user_id),
    userName: str(row.user_name),
    conversationId: str(row.conversation_id),
    conversationTitle: str(row.conversation_title),
    agentId: str(row.agent_id),
    agentName: str(row.agent_name),
    agentVersionId: str(row.agent_version_id),
    agentVersionNo: row.agent_version_no == null ? null : Number(row.agent_version_no),
    modelId: str(row.model_id),
    parentRunId: str(row.parent_run_id),
    traceId: str(row.trace_id),
    toolCount: Number(row.tool_count || 0),
    approvalCount: Number(row.approval_count || 0),
    userInputExcerpt: str(row.user_input_excerpt),
    turnNo: row.turn_no == null ? null : Number(row.turn_no),
    createdAt: formatDateTime(row.created_at),
    startedAt: formatDateTime(row.started_at),
    completedAt: formatDateTime(row.completed_at),
    updatedAt: formatDateTime(row.updated_at),
  };
}

/**
 * Text of a stored user message. Current rows are `{ text, messages, … }`;
 * a bare string or a parts array is accepted for older shapes.
 */
export function userMessageText(content: unknown): string | null {
  if (typeof content === 'string') return content || null;
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    const text = (content as { text?: unknown }).text; // 原因：content_json 解析后可能是 { text } 形态，宽容读取文本字段
    if (typeof text === 'string' && text.trim()) return text;
  }
  const contentParts = (content as { content?: unknown })?.content; // 原因：content_json 解析后可能是 { content: parts[] } 旧形态，宽容读取 parts 数组
  const parts: unknown[] = Array.isArray(content) ? content : Array.isArray(contentParts) ? contentParts : [];
  const joined = parts
    .map((p: string | { text?: unknown }) => (typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : ''))
    .filter(Boolean)
    .join('\n');
  return joined || null;
}

export class AdminRunReadRepository {
  readonly db: Knex;

  constructor(db: Knex) {
    if (!db) throw new Error('AdminRunReadRepository requires db');
    this.db = db;
  }

  #runQuery(orgId: string) {
    const db = this.db;
    return db('tbl_agsvc_runs as r')
      .leftJoin('tbl_agsvc_users as u', 'u.user_id', 'r.user_id')
      .leftJoin('tbl_agsvc_conversations as c', 'c.conversation_id', 'r.conversation_id')
      .leftJoin('tbl_agsvc_agent_versions as v', 'v.agent_version_id', 'r.agent_version_id')
      .leftJoin('tbl_agsvc_agent_definitions as d', 'd.agent_id', 'v.agent_id')
      .leftJoin('tbl_agsvc_messages as m', 'm.message_id', 'r.triggering_message_id')
      .where('r.org_id', assertUlid(orgId, 'orgId'))
      .select(
        'r.run_id', 'r.status', 'r.status_reason', 'r.source', 'r.user_id', 'r.conversation_id',
        'r.agent_version_id', 'r.parent_run_id', 'r.trace_id',
        'r.created_at', 'r.started_at', 'r.completed_at', 'r.updated_at',
        'u.display_name as user_name',
        'c.title as conversation_title',
        'v.agent_id', 'v.version_no as agent_version_no',
        'd.name as agent_name',
        db.raw("JSON_UNQUOTE(JSON_EXTRACT(v.config_json, '$.modelPolicy.modelId')) as model_id"),
        db.raw('(SELECT COUNT(*) FROM tbl_agsvc_tool_executions te WHERE te.run_id = r.run_id) as tool_count'),
        db.raw('(SELECT COUNT(*) FROM tbl_agsvc_approvals a WHERE a.run_id = r.run_id) as approval_count'),
        // Several runs of one conversation share its title; the user's own words and
        // the turn number tell them apart in the list.
        db.raw("LEFT(JSON_UNQUOTE(JSON_EXTRACT(m.content_json, '$.text')), 200) as user_input_excerpt"),
        db.raw(`CASE WHEN r.parent_run_id IS NULL AND r.conversation_id IS NOT NULL THEN (
          SELECT COUNT(*) FROM tbl_agsvc_runs r2
           WHERE r2.conversation_id = r.conversation_id AND r2.parent_run_id IS NULL
             AND (r2.created_at < r.created_at OR (r2.created_at = r.created_at AND r2.run_id <= r.run_id))
        ) END as turn_no`),
      );
  }

  async listRuns(orgId: string, f: AdminRunFilters): Promise<AdminRunRow[]> {
    let q = this.#runQuery(orgId);
    if (f.statuses?.length) q = q.whereIn('r.status', [...f.statuses]);
    if (f.agentId) q = q.andWhere('v.agent_id', assertUlid(f.agentId, 'agentId'));
    if (f.userId) q = q.andWhere('r.user_id', assertUlid(f.userId, 'userId'));
    if (f.from) q = q.andWhere('r.created_at', '>=', toMysqlDateTime(f.from));
    if (f.to) q = q.andWhere('r.created_at', '<', toMysqlDateTime(f.to));
    if (f.query) {
      const like = `%${f.query.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      const exact = f.query;
      q = q.andWhere((w: Knex.QueryBuilder) => {
        w.where('c.title', 'like', like)
          .orWhere('u.display_name', 'like', like)
          .orWhere(this.db.raw("JSON_UNQUOTE(JSON_EXTRACT(m.content_json, '$.text'))"), 'like', like)
          .orWhere('r.run_id', exact);
      });
    }
    if (f.before) {
      const at = toMysqlDateTime(f.before.createdAt);
      const id = assertUlid(f.before.runId, 'cursor.runId');
      q = q.andWhere((w: Knex.QueryBuilder) => {
        w.where('r.created_at', '<', at).orWhere((w2: Knex.QueryBuilder) => {
          w2.where('r.created_at', '=', at).andWhere('r.run_id', '<', id);
        });
      });
    }
    const rows = await q.orderBy('r.created_at', 'desc').orderBy('r.run_id', 'desc').limit(f.limit);
    return rows.map(mapAdminRun);
  }

  async getRun(orgId: string, runId: string): Promise<AdminRunRow | null> {
    const row = await this.#runQuery(orgId).andWhere('r.run_id', assertUlid(runId, 'runId')).first();
    return row ? mapAdminRun(row) : null;
  }

  /** Text of the user message that started the run, when there is one. */
  async getTriggeringText(orgId: string, runId: string): Promise<string | null> {
    const row = await this.db('tbl_agsvc_messages as m')
      .join('tbl_agsvc_runs as r', 'r.triggering_message_id', 'm.message_id')
      .where('r.org_id', assertUlid(orgId, 'orgId'))
      .andWhere('r.run_id', assertUlid(runId, 'runId'))
      .select('m.content_json')
      .first();
    return row ? userMessageText(parseJsonColumn(row.content_json)) : null;
  }

  /** Minimal rows for the stats strip; bounded so a busy org cannot stall it. */
  async listForStats(orgId: string, since: Date, limit = 20_000): Promise<{ rows: AdminRunStatRow[]; waiting: AdminRunStatRow[] }> {
    const cols = ['status', 'created_at', 'started_at', 'completed_at', 'updated_at'];
    const org = assertUlid(orgId, 'orgId');
    const [recent, waiting] = await Promise.all([
      this.db('tbl_agsvc_runs').where('org_id', org).andWhere('created_at', '>=', toMysqlDateTime(since))
        .select(cols).orderBy('created_at', 'desc').limit(limit),
      // Waiting runs count regardless of when they started.
      this.db('tbl_agsvc_runs').where('org_id', org).whereIn('status', ['WAITING_APPROVAL', 'WAITING_INPUT'])
        .select(cols).limit(limit),
    ]);
    const map = (r: Record<string, unknown>): AdminRunStatRow => ({
      status: String(r.status),
      createdAt: formatDateTime(r.created_at),
      startedAt: formatDateTime(r.started_at),
      completedAt: formatDateTime(r.completed_at),
      updatedAt: formatDateTime(r.updated_at),
    });
    return { rows: recent.map(map), waiting: waiting.map(map) };
  }

  async listEvents(orgId: string, runId: string, opts: { afterSequence: number; limit: number }) {
    const rows = await this.db('tbl_agsvc_run_events')
      .where({ run_id: assertUlid(runId, 'runId'), org_id: assertUlid(orgId, 'orgId') })
      .andWhere('sequence_no', '>', opts.afterSequence)
      .orderBy('sequence_no', 'asc')
      .limit(opts.limit);
    return rows.map(mapRunEvent);
  }

  async listTools(orgId: string, runId: string) {
    const rows = await this.db('tbl_agsvc_tool_executions as te')
      .join('tbl_agsvc_runs as r', 'r.run_id', 'te.run_id')
      .where('r.org_id', assertUlid(orgId, 'orgId'))
      .andWhere('te.run_id', assertUlid(runId, 'runId'))
      .select('te.*')
      .orderBy('te.created_at', 'asc')
      .orderBy('te.tool_execution_id', 'asc');
    return rows.map((row: Record<string, unknown>) => {
      const args = parseJsonColumn(row.arguments_json);
      const result = row.result_json == null ? null : parseJsonColumn(row.result_json);
      return {
        toolExecutionId: String(row.tool_execution_id),
        runId: String(row.run_id),
        agentSessionId: str(row.agent_session_id),
        toolCallId: String(row.tool_call_id),
        toolName: String(row.tool_name),
        toolSource: str(row.tool_source),
        riskLevel: str(row.risk_level),
        argumentsJson: publicJsonView(args) ?? {},
        resultJson: result == null ? null : publicJsonView(result),
        status: String(row.status),
        errorCode: str(row.error_code),
        startedAt: formatDateTime(row.started_at),
        completedAt: formatDateTime(row.completed_at),
        createdAt: formatDateTime(row.created_at),
      };
    });
  }

  /**
   * `skill` tool calls per (Skill name, tier) since `since`, across the org.
   *
   * The name lives in the argument envelope's `$payload`; flat legacy rows are
   * read too. Reading a Skill's files with other tools is not counted.
   *
   * **分层（ADR 0015 D1/D7 / design §7.4）**：一个名字属于哪一层由**那次 Run 的
   * AgentVersion 引用账本**决定——`skillPolicy` 只钉 system/org 两层，用户层随
   * 调用者启用集变化、不进账本，所以「不在引用账本里」就是 `user`。这与 Run 解析
   * 的优先级 system > org > user 同序（ADR 0015 D7）：一个名字被两层引用时记
   * 系统层，因为那次 Run 里生效的就是它。
   *
   * 为什么不直接存「本 Run 有效清单」：那份清单每 Run 重算且含调用者身份，落库
   * 等于给每次 Run 记一份会漂的副本。账本是**创建时冻结**的事实，用它反推是同一
   * 答案的唯一一份来源。
   *
   * 两条查询而不是一条带派生表的 JOIN：引用账本很小（每个 AgentVersion 是
   * system ∪ org 的名单），把它拉回来在内存里按 (name) 归并，比在 SQL 里把
   * `JSON_EXTRACT` 放进 JOIN 的 ON 条件更省事也更好读——后者每行都要算一次
   * JSON 路径，而且归并规则（层优先级）藏在 SQL 的 CASE 里没法单测。
   */
  async skillUsage(
    orgId: string,
    since: Date,
  ): Promise<Array<{ name: string; scope: 'system' | 'org' | 'user'; calls: number }>> {
    const scopeOrg = assertUlid(orgId, 'orgId');
    const nameExpr = `JSON_UNQUOTE(COALESCE(JSON_EXTRACT(te.arguments_json, '$."$payload".name'), JSON_EXTRACT(te.arguments_json, '$.name')))`;
    const calls: Array<Record<string, unknown>> = await this.db('tbl_agsvc_tool_executions as te')
      .join('tbl_agsvc_runs as r', 'r.run_id', 'te.run_id')
      .where('r.org_id', scopeOrg)
      .andWhere('te.tool_name', 'skill')
      .andWhere('te.created_at', '>=', toMysqlDateTime(since))
      .select(this.db.raw(`${nameExpr} as skill_name`))
      .select('r.agent_version_id')
      .count({ calls: '*' })
      .groupBy('r.agent_version_id', 'skill_name');
    const usable = calls.filter(
      (row) => row['skill_name'] != null && String(row['skill_name']) !== '',
    );
    const versionIds = [...new Set(usable.map((row) => String(row['agent_version_id'] ?? '')))]
      .filter((id) => id !== '');
    const refs: Array<Record<string, unknown>> = versionIds.length === 0 ? [] : await this.db(
      'tbl_agsvc_agent_version_skill_refs',
    )
      .whereIn('agent_version_id', versionIds)
      .select('agent_version_id', 'scope', 'skill_name');
    return mergeSkillUsageTiers(
      usable.map((row) => ({
        agentVersionId: String(row['agent_version_id'] ?? ''),
        name: String(row['skill_name']),
        calls: Number(row['calls']),
      })),
      refs.map((row) => ({
        agentVersionId: String(row['agent_version_id']),
        scope: String(row['scope']),
        name: String(row['skill_name']),
      })),
    );
  }
}

/** 引用账本里的一行：某个 AgentVersion 把某个名字钉在哪一层。 */
export interface SkillRefRow {
  readonly agentVersionId: string;
  readonly scope: string;
  readonly name: string;
}

/** 一条使用统计：名字 + 层 + 次数。也用作归并累加器。 */
export interface SkillUsageTierRow {
  name: string;
  scope: 'system' | 'org' | 'user';
  calls: number;
}

/**
 * 把「每次 Run 每个名字调了几次」按层归并（design §7.4）。
 *
 * 一个名字可能在不同 AgentVersion 下属于不同层（比如 `pdf` 在 A 版本是系统层、
 * 在 B 版本没绑定所以走用户层），所以结果是 **(名字, 层)** 而不是按名字——把两层
 * 合成一个数字，管理员就答不出「这个系统 Skill 到底有没有人用」。
 *
 * 层优先级 system > org > user 与 Run 解析同序（ADR 0015 D7）：被系统层引用的
 * 名字在那次 Run 里生效的就是系统层那份，用户层那份根本没挂上。
 */
export function mergeSkillUsageTiers(
  calls: ReadonlyArray<{ agentVersionId: string; name: string; calls: number }>,
  refs: readonly SkillRefRow[],
): SkillUsageTierRow[] {
  const byVersion = new Map<string, Set<string>>();
  for (const ref of refs) {
    const key = `${ref.agentVersionId}\u0000${ref.scope}`;
    const names = byVersion.get(key) ?? new Set<string>();
    names.add(ref.name);
    byVersion.set(key, names);
  }
  // 类型参数刻意用**具名类型**而不是内联对象字面量：结构审计的门禁正则跳过
  // 类型参数里含 `{ ; }` 的 `new Map<…>`（见 STATUS B3 记录的已知缺口），
  // 写成内联形状会让这张表从「已登记的瞬态 Map」清单里消失。
  const totals = new Map<string, SkillUsageTierRow>();
  for (const call of calls) {
    const scope: 'system' | 'org' | 'user' =
      byVersion.get(`${call.agentVersionId}\u0000system`)?.has(call.name) ? 'system'
        : byVersion.get(`${call.agentVersionId}\u0000org`)?.has(call.name) ? 'org'
          : 'user';
    const key = `${call.name}\u0000${scope}`;
    const entry = totals.get(key) ?? { name: call.name, scope, calls: 0 };
    entry.calls += call.calls;
    totals.set(key, entry);
  }
  return [...totals.values()].sort(
    (a, b) => b.calls - a.calls || a.name.localeCompare(b.name) || a.scope.localeCompare(b.scope),
  );
}
