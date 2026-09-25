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

type Loose = any;

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
    const text = (content as Loose).text;
    if (typeof text === 'string' && text.trim()) return text;
  }
  const parts = Array.isArray(content) ? content : Array.isArray((content as Loose)?.content) ? (content as Loose).content : [];
  const joined = parts
    .map((p: Loose) => (typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : ''))
    .filter(Boolean)
    .join('\n');
  return joined || null;
}

export class AdminRunReadRepository {
  readonly db: Loose;

  constructor(db: Loose) {
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
      q = q.andWhere((w: Loose) => {
        w.where('c.title', 'like', like)
          .orWhere('u.display_name', 'like', like)
          .orWhere('r.run_id', exact);
      });
    }
    if (f.before) {
      const at = toMysqlDateTime(f.before.createdAt);
      const id = assertUlid(f.before.runId, 'cursor.runId');
      q = q.andWhere((w: Loose) => {
        w.where('r.created_at', '<', at).orWhere((w2: Loose) => {
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
}
