/**
 * Dependency-free in-memory world for Create/Get/Cancel run service tests.
 * Supports transactions with commit/rollback, unique constraints, FOR UPDATE,
 * LAST_INSERT_ID sequence allocation, and injectable queue/cancel failures.
 */

import { OrganizationRepository } from '../../../src/infrastructure/mysql/repositories/organization-repository.js';
import { ExternalReferenceRepository } from '../../../src/infrastructure/mysql/repositories/external-reference-repository.js';
import { AgentCatalogRepository } from '../../../src/infrastructure/mysql/repositories/agent-catalog-repository.js';
import { ConversationRepository } from '../../../src/infrastructure/mysql/repositories/conversation-repository.js';
import { AgentSessionRepository } from '../../../src/infrastructure/mysql/repositories/agent-session-repository.js';
import { MessageRepository } from '../../../src/infrastructure/mysql/repositories/message-repository.js';
import { RunRepository } from '../../../src/infrastructure/mysql/repositories/run-repository.js';
import { RunEventRepository } from '../../../src/infrastructure/mysql/repositories/run-event-repository.js';
import { IdempotencyRepository } from '../../../src/infrastructure/mysql/repositories/idempotency-repository.js';
import { OutboxRepository } from '../../../src/infrastructure/outbox/outbox-repository.js';
import { createUlidGenerator } from '../../../src/domain/shared/ulid.js';

/**
 * Deep clone plain JSON-compatible data.
 * @param {unknown} v
 */
function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

/**
 * @param {unknown} left
 * @param {string} op
 * @param {unknown} right
 */
function cmp(left, op, right) {
  const lv = Date.parse(
    String(left).includes('T')
      ? String(left)
      : `${String(left).replace(' ', 'T')}Z`,
  );
  const rv = Date.parse(
    String(right).includes('T')
      ? String(right)
      : `${String(right).replace(' ', 'T')}Z`,
  );
  if (Number.isFinite(lv) && Number.isFinite(rv)) {
    if (op === '<=') return lv <= rv;
    if (op === '<') return lv < rv;
    if (op === '>') return lv > rv;
    if (op === '>=') return lv >= rv;
  }
  const nL = Number(left);
  const nR = Number(right);
  if (Number.isFinite(nL) && Number.isFinite(nR) && op !== undefined) {
    if (op === '>') return nL > nR;
    if (op === '>=') return nL >= nR;
    if (op === '<') return nL < nR;
    if (op === '<=') return nL <= nR;
  }
  const ls = String(left);
  const rs = String(right);
  if (op === '<=') return ls <= rs;
  if (op === '<') return ls < rs;
  if (op === '>') return ls > rs;
  if (op === '>=') return ls >= rs;
  return false;
}

/**
 * @param {{ failNextTxn?: boolean }} [opts]
 */
export function createFakeRunWorld(opts = {}) {
  /** @type {Record<string, Record<string, unknown>[]>} */
  const tables = {
    organizations: [],
    users: [],
    organization_memberships: [],
    organization_external_refs: [],
    conversation_external_refs: [],
    agent_definitions: [],
    agent_versions: [],
    conversations: [],
    agent_sessions: [],
    messages: [],
    runs: [],
    run_events: [],
    tool_executions: [],
    idempotency_records: [],
    domain_outbox: [],
  };

  let lastInsertId = 0;
  /** @type {Array<{ sql: string, bindings: unknown[] }>} */
  const rawCalls = [];
  /** @type {Array<{ runId: string, orgId: string, traceId: string }>} */
  const enqueuedJobs = [];
  /** @type {Array<{ runId: string, meta: object }>} */
  const cancelSignals = [];

  let queueFail = false;
  let cancelSignalFail = false;
  let failNextTxn = opts.failNextTxn === true;
  let commitCount = 0;
  let rollbackCount = 0;

  /**
   * Unique key violation for a table/row.
   * @param {string} tableName
   * @param {Record<string, unknown>} row
   */
  function assertUnique(tableName, row) {
    const t = tables[tableName] || [];
    const conflict = (pred) => {
      if (t.some(pred)) {
        const err = new Error(`Duplicate entry for ${tableName}`);
        // @ts-ignore
        err.code = 'ER_DUP_ENTRY';
        // @ts-ignore
        err.errno = 1062;
        throw err;
      }
    };
    if (tableName === 'organizations') {
      conflict((r) => r.org_id === row.org_id);
    }
    if (tableName === 'users') {
      conflict(
        (r) =>
          r.user_id === row.user_id ||
          r.external_subject === row.external_subject,
      );
    }
    if (tableName === 'organization_memberships') {
      conflict((r) => r.org_id === row.org_id && r.user_id === row.user_id);
    }
    if (tableName === 'organization_external_refs') {
      conflict(
        (r) =>
          r.provider === row.provider &&
          r.external_subject === row.external_subject,
      );
    }
    if (tableName === 'conversation_external_refs') {
      conflict(
        (r) =>
          r.org_id === row.org_id &&
          r.user_id === row.user_id &&
          r.provider === row.provider &&
          r.external_subject === row.external_subject,
      );
    }
    if (tableName === 'agent_definitions') {
      conflict((r) => r.agent_id === row.agent_id);
    }
    if (tableName === 'agent_versions') {
      conflict(
        (r) =>
          r.agent_version_id === row.agent_version_id ||
          (r.agent_id === row.agent_id && r.version_no === row.version_no),
      );
    }
    if (tableName === 'conversations') {
      conflict((r) => r.conversation_id === row.conversation_id);
    }
    if (tableName === 'agent_sessions') {
      conflict((r) => r.agent_session_id === row.agent_session_id);
    }
    if (tableName === 'messages') {
      conflict(
        (r) =>
          r.message_id === row.message_id ||
          (r.conversation_id === row.conversation_id &&
            r.sequence_no === row.sequence_no),
      );
    }
    if (tableName === 'runs') {
      conflict((r) => r.run_id === row.run_id);
    }
    if (tableName === 'run_events') {
      conflict(
        (r) =>
          r.event_id === row.event_id ||
          (r.run_id === row.run_id && r.sequence_no === row.sequence_no),
      );
    }
    if (tableName === 'idempotency_records') {
      conflict(
        (r) =>
          r.org_id === row.org_id &&
          r.user_id === row.user_id &&
          r.idempotency_key === row.idempotency_key &&
          r.operation === row.operation,
      );
    }
    if (tableName === 'domain_outbox') {
      conflict((r) => r.outbox_id === row.outbox_id);
    }
  }

  /**
   * @param {Record<string, Record<string, unknown>[]>} baseTables
   * @param {{ isTransaction?: boolean }} [qopts]
   */
  function createExecutor(baseTables, qopts = {}) {
    const isTransaction = qopts.isTransaction === true;

    /**
     * @param {string} tableName
     */
    function createQuery(tableName) {
      const bare = tableName.replace(/\s+as\s+\w+$/i, '');
      /** @type {Array<[string, unknown]>} */
      const filters = [];
      /** @type {Array<[string, unknown[]]>} */
      const inFilters = [];
      /** @type {string[]} */
      const nullCols = [];
      /** @type {string[]} */
      const notNullCols = [];
      /** @type {{ col: string, dir: string } | null} */
      let order = null;
      /** @type {number | null} */
      let limitN = null;
      /** @type {'select'|'insert'|'update'|'max'} */
      let type = 'select';
      /** @type {Record<string, unknown> | null} */
      let insertRow = null;
      /** @type {Record<string, unknown> | null} */
      let updates = null;
      /** @type {string | null} */
      let maxCol = null;
      /** @type {{ table: string, left: string, right: string } | null} */
      let join = null;

      const rowMatches = (row) => {
        for (const col of nullCols) {
          if (row[col] != null) return false;
        }
        for (const col of notNullCols) {
          if (row[col] == null) return false;
        }
        for (const [col, val] of filters) {
          const key = col.includes('.') ? col.split('.').pop() : col;
          if (val && typeof val === 'object' && 'op' in /** @type {any} */ (val)) {
            const pred = /** @type {{ op: string, value: unknown }} */ (val);
            if (!cmp(row[/** @type {string} */ (key)], pred.op, pred.value)) {
              return false;
            }
          } else if (row[/** @type {string} */ (key)] !== val) {
            return false;
          }
        }
        for (const [col, vals] of inFilters) {
          if (!vals.includes(row[col])) return false;
        }
        return true;
      };

      const api = {
        where(colOrObj, val) {
          if (typeof colOrObj === 'object' && colOrObj !== null) {
            for (const [k, v] of Object.entries(colOrObj)) {
              filters.push([k, v]);
            }
          } else {
            filters.push([String(colOrObj), val]);
          }
          return api;
        },
        andWhere(col, opOrVal, maybeVal) {
          if (maybeVal !== undefined) {
            filters.push([String(col), { op: opOrVal, value: maybeVal }]);
          } else if (typeof col === 'object' && col !== null) {
            for (const [k, v] of Object.entries(col)) {
              filters.push([k, v]);
            }
          } else {
            filters.push([String(col), opOrVal]);
          }
          return api;
        },
        whereIn(col, vals) {
          inFilters.push([String(col), [...vals]]);
          return api;
        },
        whereNull(col) {
          nullCols.push(String(col));
          return api;
        },
        whereNotNull(col) {
          notNullCols.push(String(col));
          return api;
        },
        join(table, left, right) {
          join = { table, left, right };
          return api;
        },
        select() {
          return api;
        },
        orderBy(col, dir = 'asc') {
          order = { col, dir };
          return api;
        },
        limit(n) {
          limitN = n;
          return api;
        },
        forUpdate() {
          return api;
        },
        max(expr) {
          type = 'max';
          maxCol = expr;
          return api;
        },
        insert(row) {
          type = 'insert';
          insertRow = row;
          return Promise.resolve().then(() => {
            assertUnique(bare, /** @type {Record<string, unknown>} */ (row));
            if (!baseTables[bare]) baseTables[bare] = [];
            baseTables[bare].push({ ...row });
            return 1;
          });
        },
        update(patch) {
          type = 'update';
          updates = patch;
          return Promise.resolve().then(() => {
            const table = baseTables[bare] || [];
            let n = 0;
            for (const row of table) {
              if (rowMatches(row)) {
                Object.assign(row, updates);
                n += 1;
              }
            }
            return n;
          });
        },
        first() {
          limitN = 1;
          return Promise.resolve().then(() => {
            if (type === 'max') {
              const table = baseTables[bare] || [];
              const filtered = table.filter(rowMatches);
              const col = String(maxCol).split(' ')[0];
              let max = null;
              for (const row of filtered) {
                const v = Number(row[col]);
                if (max == null || v > max) max = v;
              }
              return { max_seq: max };
            }
            const rows = runSelect();
            return rows[0];
          });
        },
        then(resolve, reject) {
          return Promise.resolve()
            .then(() => {
              if (type === 'max') {
                return api.first();
              }
              return runSelect();
            })
            .then(resolve, reject);
        },
      };

      function runSelect() {
        let rows = [...(baseTables[bare] || [])].filter(rowMatches);
        if (join) {
          const otherName = join.table.replace(/\s+as\s+\w+$/i, '');
          const other = baseTables[otherName] || [];
          const leftKey = join.left.split('.').pop();
          const rightKey = join.right.split('.').pop();
          rows = rows
            .map((leftRow) => {
              const match = other.find(
                (r) => r[/** @type {string} */ (rightKey)] === leftRow[/** @type {string} */ (leftKey)],
              );
              if (!match) return null;
              return { ...leftRow, __join: match };
            })
            .filter(Boolean);
          rows = rows.filter((combined) => {
            return filters.every(([col, val]) => {
              if (col.startsWith('c.') || col.startsWith('r.')) {
                const k = col.split('.')[1];
                return combined.__join[k] === val;
              }
              if (col.startsWith('m.') || col.startsWith('e.')) {
                const k = col.split('.')[1];
                return combined[k] === val;
              }
              const key = col.includes('.') ? col.split('.').pop() : col;
              return combined[/** @type {string} */ (key)] === val;
            });
          });
          // strip join helper for message/event mappers
          rows = rows.map((r) => {
            const { __join, ...rest } = r;
            void __join;
            return rest;
          });
        }
        if (order) {
          const { col, dir } = order;
          rows = [...rows].sort((a, b) => {
            if (a[col] === b[col]) return 0;
            if (a[col] > b[col]) return dir === 'desc' ? -1 : 1;
            return dir === 'desc' ? 1 : -1;
          });
        }
        if (limitN != null) rows = rows.slice(0, limitN);
        return rows;
      }

      return api;
    }

    /** @type {any} */
    const knex = (table) => createQuery(table);
    knex.isTransaction = isTransaction;
    knex.raw = async (sql, bindings = []) => {
      rawCalls.push({ sql: String(sql), bindings: [...bindings] });
      const s = String(sql);

      // Sequence allocation for run events
      if (/UPDATE\s+runs\s+SET\s+next_event_sequence/i.test(s)) {
        const runId = bindings[1];
        const orgId = bindings[2];
        const userId = bindings[3];
        const row = (baseTables.runs || []).find(
          (r) =>
            r.run_id === runId && r.org_id === orgId && r.user_id === userId,
        );
        if (!row) {
          return [{ affectedRows: 0 }];
        }
        const next = Number(row.next_event_sequence || 0) + 1;
        row.next_event_sequence = next;
        if (bindings[0]) row.updated_at = bindings[0];
        lastInsertId = next;
        return [{ affectedRows: 1 }];
      }
      if (/SELECT\s+LAST_INSERT_ID\(\)/i.test(s)) {
        return [[{ seq: lastInsertId }]];
      }
      return [[]];
    };
    knex.transaction = async (fn) => {
      // Nested: share same tables (savepoint-less).
      const nested = createExecutor(baseTables, { isTransaction: true });
      return fn(nested);
    };
    knex.__tables = baseTables;
    return knex;
  }

  /**
   * Transaction manager: snapshot on begin, restore on throw (rollback).
   */
  const transactionManager = {
    async run(work) {
      const snapshot = clone(tables);
      const trxTables = /** @type {typeof tables} */ (clone(tables));
      // Bind live writes into trxTables, commit copies into tables.
      // Share array identity by reassigning into wrapper.
      for (const k of Object.keys(tables)) {
        tables[k] = trxTables[k];
      }
      const trx = createExecutor(tables, { isTransaction: true });
      try {
        if (failNextTxn) {
          failNextTxn = false;
          throw new Error('simulated transaction failure');
        }
        const result = await work(trx);
        // commit: tables already mutated in place
        commitCount += 1;
        return result;
      } catch (err) {
        // rollback
        for (const k of Object.keys(snapshot)) {
          tables[k] = snapshot[k];
        }
        for (const k of Object.keys(tables)) {
          if (!(k in snapshot)) delete tables[k];
        }
        rollbackCount += 1;
        throw err;
      }
    },
  };

  const rootDb = createExecutor(tables, { isTransaction: false });

  /**
   * @param {any} db
   */
  function createRepositories(db) {
    const now = () => new Date('2026-07-18T06:00:00.000Z');
    return {
      organizations: new OrganizationRepository(db, { now }),
      externalRefs: new ExternalReferenceRepository(db, { now }),
      catalog: new AgentCatalogRepository(db, { now }),
      conversations: new ConversationRepository(db),
      sessions: new AgentSessionRepository(db),
      messages: new MessageRepository(db),
      runs: new RunRepository(db, { now }),
      runEvents: new RunEventRepository(db),
      toolExecutions: {
        async listByRun(runId, scope) {
          const ownedRun = tables.runs.find(
            (row) =>
              row.run_id === runId &&
              row.org_id === scope.orgId &&
              row.user_id === scope.userId,
          );
          if (!ownedRun) {
            throw new Error('Run not found for tool execution scope');
          }
          return tables.tool_executions
            .filter((row) => row.run_id === runId)
            .map((row) => ({
              toolExecutionId: row.tool_execution_id,
              runId: row.run_id,
              status: row.status,
            }));
        },
      },
      idempotency: new IdempotencyRepository(db, { now }),
      outbox: new OutboxRepository(db, { now }),
    };
  }

  let idCounter = 0;
  // Deterministic-ish ULIDs via injectable time + counter entropy.
  const generateId = createUlidGenerator({
    now: () => 1_721_278_800_000 + idCounter,
    randomBytes: (n) => {
      const buf = Buffer.alloc(n);
      idCounter += 1;
      buf.writeUInt32BE(idCounter, 0);
      return buf;
    },
  });

  const runQueue = {
    /**
     * @param {{ runId: string, orgId: string, traceId: string }} ref
     */
    async enqueue(ref) {
      if (queueFail) {
        throw new Error('queue unavailable');
      }
      enqueuedJobs.push({ ...ref });
      return { id: ref.runId };
    },
    setFail(v) {
      queueFail = v === true;
    },
  };

  const cancelSignal = {
    /**
     * @param {string} runId
     * @param {object} [meta]
     */
    async request(runId, meta = {}) {
      if (cancelSignalFail) {
        throw new Error('redis cancel signal failed');
      }
      cancelSignals.push({ runId, meta });
    },
    /**
     * @param {string} runId
     */
    async isRequested(runId) {
      return cancelSignals.some((s) => s.runId === runId);
    },
    setFail(v) {
      cancelSignalFail = v === true;
    },
  };

  return {
    tables,
    rawCalls,
    enqueuedJobs,
    cancelSignals,
    transactionManager,
    createRepositories,
    generateId,
    runQueue,
    cancelSignal,
    rootDb,
    get commitCount() {
      return commitCount;
    },
    get rollbackCount() {
      return rollbackCount;
    },
    failNextTransaction() {
      failNextTxn = true;
    },
    snapshot() {
      return clone(tables);
    },
  };
}

export const TRACE = 'a'.repeat(32);
export const FIXED_AUTH = {
  provider: 'bff',
  externalOrgId: '550e8400-e29b-41d4-a716-446655440000',
  externalUserId: '660e8400-e29b-41d4-a716-446655440001',
  displayName: 'Test User',
};
