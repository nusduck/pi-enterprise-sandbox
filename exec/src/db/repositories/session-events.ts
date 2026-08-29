/**
 * session_events 仓储——ADR 0005 决策 2 的 exec 侧落地（引擎原生事件
 * 拆到独立物理表）。
 *
 * 背景：原 `messages` 表用 `pi_entry_id IS NULL` 区分引擎事件与用户消息，
 * 宽 JSON 行干扰普通会话查询；新设计 `messages` 只留用户可见消息，引擎
 * 事件进 `session_events`（带 `seq` 主序，`agent_session_id + seq` 唯一）。
 * 这张表的权威迁移同样在 `agent/`（`20260718000007_pi_session_journal.js`
 * 的演进），exec 侧此处提供仓储类與 DDL，供 W4-B 的 `mysql-session-store`
 *（8 方法）复用——`loadStored/readStoredRevision/loadStoredFrom/appendBatch/
 * commitRepair/list` 均以它为底。
 */

import type { Pool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';

export interface SessionEventRow {
  readonly agentSessionId: string;
  readonly seq: number;
  readonly eventType: string;
  readonly payloadJson: string;
  readonly createdAt: Date;
}

export interface SessionEventInsert {
  readonly agentSessionId: string;
  readonly seq: number;
  readonly eventType: string;
  readonly payloadJson: string;
}

export const SESSION_EVENTS_DDL = `
CREATE TABLE session_events (
  agent_session_id CHAR(26)       NOT NULL,
  seq              BIGINT UNSIGNED NOT NULL,
  event_type       VARCHAR(128)  NOT NULL,
  payload_json     JSON          NOT NULL,
  created_at       DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (agent_session_id, seq),
  KEY idx_session_events_seq (agent_session_id, seq)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`.trim();

interface Row extends RowDataPacket {
  agent_session_id: string;
  seq: number | string;
  event_type: string;
  payload_json: string;
  created_at: Date;
}

function mapRow(r: Row): SessionEventRow {
  return {
    agentSessionId: r.agent_session_id,
    seq: Number(r.seq),
    eventType: r.event_type,
    payloadJson: r.payload_json,
    createdAt: r.created_at,
  };
}

export class MySqlSessionEventStore {
  constructor(
    private readonly pool: Pool,
    private readonly table: string = 'session_events',
  ) {}

  async appendBatch(rows: readonly SessionEventInsert[]): Promise<void> {
    if (rows.length === 0) return;
    const values = rows.map(() => '(?, ?, ?, ?)').join(', ');
    const params: unknown[] = [];
    for (const r of rows) params.push(r.agentSessionId, r.seq, r.eventType, r.payloadJson);
    await this.pool.execute<ResultSetHeader>(
      `INSERT INTO ${this.table} (agent_session_id, seq, event_type, payload_json) VALUES ${values}`,
      params,
    );
  }

  async list(
    agentSessionId: string,
    fromSeq?: number | undefined,
  ): Promise<SessionEventRow[]> {
    if (fromSeq !== undefined) {
      const [rows] = await this.pool.execute<Row[]>(
        `SELECT * FROM ${this.table} WHERE agent_session_id = ? AND seq >= ? ORDER BY seq ASC`,
        [agentSessionId, fromSeq],
      );
      return (rows as Row[]).map(mapRow);
    }
    const [rows] = await this.pool.execute<Row[]>(
      `SELECT * FROM ${this.table} WHERE agent_session_id = ? ORDER BY seq ASC`,
      [agentSessionId],
    );
    return (rows as Row[]).map(mapRow);
  }

  async maxSeq(agentSessionId: string): Promise<number | null> {
    const [rows] = await this.pool.execute<Row[]>(
      `SELECT MAX(seq) as seq FROM ${this.table} WHERE agent_session_id = ?`,
      [agentSessionId],
    );
    const v = (rows[0] as unknown as { seq: number | null })?.seq;
    return v === null || v === undefined ? null : Number(v);
  }
}

export class InMemorySessionEventStore {
  private readonly map = new Map<string, SessionEventRow[]>();

  async appendBatch(rows: readonly SessionEventInsert[]): Promise<void> {
    for (const r of rows) {
      const list = this.map.get(r.agentSessionId) ?? [];
      list.push({ ...r, createdAt: new Date() });
      list.sort((a, b) => a.seq - b.seq);
      this.map.set(r.agentSessionId, list);
    }
  }

  async list(agentSessionId: string, fromSeq?: number | undefined): Promise<SessionEventRow[]> {
    const list = this.map.get(agentSessionId) ?? [];
    if (fromSeq !== undefined) return list.filter((r) => r.seq >= fromSeq);
    return [...list];
  }

  async maxSeq(agentSessionId: string): Promise<number | null> {
    const list = this.map.get(agentSessionId);
    if (!list || list.length === 0) return null;
    return Math.max(...list.map((r) => r.seq));
  }
}
