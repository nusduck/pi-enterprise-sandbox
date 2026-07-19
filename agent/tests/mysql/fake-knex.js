/**
 * Minimal knex-like fake for repository unit tests (no knex/mysql2 required).
 */

/**
 * @typedef {object} FakeState
 * @property {Record<string, Record<string, unknown>[]>} tables
 * @property {Array<{ sql: string, bindings: unknown[] }>} rawCalls
 * @property {number} lastInsertId
 */

/**
 * @returns {FakeState}
 */
export function createFakeState() {
  return {
    tables: Object.create(null),
    rawCalls: [],
    lastInsertId: 0,
    /** @type {Array<{ table: string, mode: 'share' | 'update' }>} */
    lockCalls: [],
  };
}

/**
 * Build a chainable query builder bound to in-memory tables.
 * @param {FakeState} state
 * @param {string} tableName
 * @param {{ isTransaction?: boolean }} [opts]
 */
function createQuery(state, tableName, opts = {}) {
  /** @type {{ type: string, filters: Array<[string, unknown]>, inFilters: Array<[string, unknown[]]>, notInFilters: Array<[string, unknown[]]>, order?: { col: string, dir: string }, limitN?: number, forUpdateFlag?: boolean, forShareFlag?: boolean, join?: { table: string, left: string, right: string }, selectCols?: string[], maxCol?: string, updates?: Record<string, unknown>, insertRow?: Record<string, unknown> }} */
  const ctx = {
    type: 'select',
    filters: [],
    inFilters: [],
    notInFilters: [],
  };

  const ensureTable = (name) => {
    if (!state.tables[name]) state.tables[name] = [];
    return state.tables[name];
  };

  const baseAlias = tableName.includes(' as ')
    ? tableName.split(' as ')[1].trim()
    : null;

  const matches = (row) => {
    const eqOk = ctx.filters.every(([col, val]) => {
      if (col.includes('.')) {
        const [alias, bare] = col.split('.');
        // Defer joined-table predicates until after join (e.g. c.org_id).
        if (ctx.join) {
          const joinAlias = ctx.join.table.includes(' as ')
            ? ctx.join.table.split(' as ')[1].trim()
            : null;
          if (joinAlias && alias === joinAlias) return true;
          if (baseAlias && alias !== baseAlias) return true;
        }
        return row[bare] === val || row[col] === val;
      }
      if (val && typeof val === 'object' && 'op' in val) {
        if (val.op === 'notnull') {
          return row[col] != null;
        }
        if (val.op === 'isnull') {
          return row[col] == null;
        }
        const left = Number(row[col]);
        if (val.op === '>') return left > Number(val.value);
        if (val.op === '>=') return left >= Number(val.value);
        if (val.op === '<') return left < Number(val.value);
        return false;
      }
      return row[col] === val;
    });
    if (!eqOk) return false;
    const inOk = ctx.inFilters.every(([col, vals]) => {
      const key = col.includes('.') ? col.split('.').pop() : col;
      return vals.includes(row[key]);
    });
    if (!inOk) return false;
    return ctx.notInFilters.every(([col, vals]) => {
      const key = col.includes('.') ? col.split('.').pop() : col;
      return !vals.includes(row[key]);
    });
  };

  const api = {
    where(colOrObj, val) {
      if (typeof colOrObj === 'object' && colOrObj !== null) {
        for (const [k, v] of Object.entries(colOrObj)) {
          ctx.filters.push([k, v]);
        }
      } else {
        ctx.filters.push([String(colOrObj), val]);
      }
      return api;
    },
    andWhere(col, opOrVal, maybeVal) {
      if (maybeVal !== undefined) {
        // andWhere('sequence_no', '>', after)
        ctx.filters.push([
          String(col),
          { op: opOrVal, value: maybeVal },
        ]);
      } else if (typeof col === 'object') {
        for (const [k, v] of Object.entries(col)) {
          ctx.filters.push([k, v]);
        }
      } else {
        ctx.filters.push([String(col), opOrVal]);
      }
      return api;
    },
    whereIn(col, vals) {
      ctx.inFilters.push([String(col), [...vals]]);
      return api;
    },
    whereNotIn(col, vals) {
      ctx.notInFilters.push([String(col), [...vals]]);
      return api;
    },
    whereNotNull(col) {
      ctx.filters.push([String(col), { op: 'notnull' }]);
      return api;
    },
    whereNull(col) {
      ctx.filters.push([String(col), { op: 'isnull' }]);
      return api;
    },
    join(table, left, right) {
      ctx.join = { table, left, right };
      return api;
    },
    select(...cols) {
      ctx.selectCols = cols.flat();
      return api;
    },
    orderBy(col, dir = 'asc') {
      ctx.order = { col, dir };
      return api;
    },
    limit(n) {
      ctx.limitN = n;
      return api;
    },
    forUpdate() {
      ctx.forUpdateFlag = true;
      ctx.forShareFlag = false;
      return api;
    },
    forShare() {
      ctx.forShareFlag = true;
      ctx.forUpdateFlag = false;
      return api;
    },
    max(expr) {
      // max('sequence_no as max_seq')
      ctx.type = 'max';
      ctx.maxCol = expr;
      return api;
    },
    insert(row) {
      ctx.type = 'insert';
      ctx.insertRow = row;
      return Promise.resolve(run());
    },
    update(patch) {
      ctx.type = 'update';
      ctx.updates = patch;
      return Promise.resolve(run());
    },
    first() {
      ctx.limitN = 1;
      return Promise.resolve(run()).then((rows) => {
        if (ctx.type === 'max') return rows;
        return Array.isArray(rows) ? rows[0] : rows;
      });
    },
    then(resolve, reject) {
      return Promise.resolve(run()).then(resolve, reject);
    },
  };

  const rowMatches = matches;

  function run() {
    const bareTable = tableName.replace(/ as .*$/, '');
    const table = ensureTable(bareTable);

    // Record lock mode for parent/child concurrency tests (PR-07B batch 2B).
    if (ctx.forShareFlag || ctx.forUpdateFlag) {
      if (!state.lockCalls) state.lockCalls = [];
      state.lockCalls.push({
        table: bareTable,
        mode: ctx.forUpdateFlag ? 'update' : 'share',
        joined: Boolean(ctx.join),
      });
    }

    if (ctx.type === 'insert') {
      const row = { ...ctx.insertRow };
      const bareTable = tableName.replace(/ as .*$/, '');
      // Unique key simulation for agent_session_snapshots (session + version).
      if (bareTable === 'agent_session_snapshots') {
        const dup = table.some(
          (r) =>
            r.agent_session_id === row.agent_session_id &&
            Number(r.snapshot_version) === Number(row.snapshot_version),
        );
        if (dup) {
          const err = new Error('Duplicate entry for uk_session_snapshot');
          // @ts-ignore
          err.code = 'ER_DUP_ENTRY';
          // @ts-ignore
          err.errno = 1062;
          throw err;
        }
      }
      // PR-05 journal: UNIQUE (agent_session_id, pi_entry_id) when both non-null.
      if (bareTable === 'messages') {
        if (row.pi_entry_id != null && row.agent_session_id != null) {
          const dup = table.some(
            (r) =>
              r.agent_session_id === row.agent_session_id &&
              r.pi_entry_id != null &&
              r.pi_entry_id === row.pi_entry_id,
          );
          if (dup) {
            const err = new Error('Duplicate entry for uk_messages_session_pi_entry');
            // @ts-ignore
            err.code = 'ER_DUP_ENTRY';
            // @ts-ignore
            err.errno = 1062;
            throw err;
          }
        }
        if (row.message_id != null) {
          const dupId = table.some((r) => r.message_id === row.message_id);
          if (dupId) {
            const err = new Error('Duplicate entry for messages.PRIMARY');
            // @ts-ignore
            err.code = 'ER_DUP_ENTRY';
            // @ts-ignore
            err.errno = 1062;
            throw err;
          }
        }
        if (row.conversation_id != null && row.sequence_no != null) {
          const dupSeq = table.some(
            (r) =>
              r.conversation_id === row.conversation_id &&
              Number(r.sequence_no) === Number(row.sequence_no),
          );
          if (dupSeq) {
            const err = new Error('Duplicate entry for uk_message_sequence');
            // @ts-ignore
            err.code = 'ER_DUP_ENTRY';
            // @ts-ignore
            err.errno = 1062;
            throw err;
          }
        }
      }
      // PR-06 B2: tool_executions UNIQUE(run_id, tool_call_id)
      if (bareTable === 'tool_executions') {
        if (row.tool_execution_id != null) {
          const dupPk = table.some(
            (r) => r.tool_execution_id === row.tool_execution_id,
          );
          if (dupPk) {
            const err = new Error('Duplicate entry for tool_executions.PRIMARY');
            // @ts-ignore
            err.code = 'ER_DUP_ENTRY';
            // @ts-ignore
            err.errno = 1062;
            throw err;
          }
        }
        if (row.run_id != null && row.tool_call_id != null) {
          const dup = table.some(
            (r) =>
              r.run_id === row.run_id && r.tool_call_id === row.tool_call_id,
          );
          if (dup) {
            const err = new Error('Duplicate entry for uk_tool_call');
            // @ts-ignore
            err.code = 'ER_DUP_ENTRY';
            // @ts-ignore
            err.errno = 1062;
            throw err;
          }
        }
      }
      if (bareTable === 'approvals' && row.approval_id != null) {
        const dup = table.some((r) => r.approval_id === row.approval_id);
        if (dup) {
          const err = new Error('Duplicate entry for approvals.PRIMARY');
          // @ts-ignore
          err.code = 'ER_DUP_ENTRY';
          // @ts-ignore
          err.errno = 1062;
          throw err;
        }
      }
      if (bareTable === 'run_interactions') {
        const dup = table.some(
          (r) =>
            r.interaction_id === row.interaction_id ||
            (r.run_id === row.run_id && r.tool_call_id === row.tool_call_id),
        );
        if (dup) {
          const err = new Error('Duplicate entry for run_interactions');
          // @ts-ignore
          err.code = 'ER_DUP_ENTRY';
          // @ts-ignore
          err.errno = 1062;
          throw err;
        }
      }
      if (bareTable === 'sandbox_audit_events' && row.audit_id != null) {
        const dup = table.some((r) => r.audit_id === row.audit_id);
        if (dup) {
          const err = new Error('Duplicate entry for sandbox_audit_events.PRIMARY');
          // @ts-ignore
          err.code = 'ER_DUP_ENTRY';
          // @ts-ignore
          err.errno = 1062;
          throw err;
        }
      }
      if (bareTable === 'trace_spans') {
        const dup = table.some(
          (r) => r.trace_id === row.trace_id && r.span_id === row.span_id,
        );
        if (dup) {
          const err = new Error('Duplicate entry for trace_spans.PRIMARY');
          // @ts-ignore
          err.code = 'ER_DUP_ENTRY';
          // @ts-ignore
          err.errno = 1062;
          throw err;
        }
      }
      // parse JSON strings like mysql would store objects sometimes
      table.push(row);
      return 1;
    }

    if (ctx.type === 'update') {
      let count = 0;
      for (const row of table) {
        if (rowMatches(row)) {
          Object.assign(row, ctx.updates);
          count += 1;
        }
      }
      return count;
    }

    if (ctx.type === 'max') {
      const filtered = table.filter(rowMatches);
      const col = String(ctx.maxCol).split(' ')[0];
      let max = null;
      for (const row of filtered) {
        const v = Number(row[col]);
        if (max == null || v > max) max = v;
      }
      return { max_seq: max };
    }

    let rows = table.filter(rowMatches);

    if (ctx.join) {
      const other = ensureTable(ctx.join.table.replace(/ as .*$/, ''));
      const leftKey = ctx.join.left.split('.').pop();
      const rightKey = ctx.join.right.split('.').pop();
      // Support messages as m join conversations as c — tableName may be "messages as m"
      const leftAlias = tableName.includes(' as ')
        ? tableName.split(' as ')[1].trim()
        : null;
      rows = rows
        .map((leftRow) => {
          const match = other.find((r) => r[rightKey] === leftRow[leftKey]);
          if (!match) return null;
          // ownership filters on c.org_id applied via andWhere after join
          return { ...leftRow, __join: match };
        })
        .filter(Boolean);

      // Apply filters that target joined table (c.org_id)
      rows = rows.filter((combined) => {
        return ctx.filters.every(([col, val]) => {
          if (col.startsWith('c.') || col.startsWith('r.')) {
            const k = col.split('.')[1];
            const jval = combined.__join[k];
            return jval === val;
          }
          if (
            col.startsWith('m.') ||
            col.startsWith('e.') ||
            col.startsWith('te.') ||
            col.startsWith('a.')
          ) {
            const k = col.split('.')[1];
            return combined[k] === val;
          }
          if (leftAlias && col.startsWith(`${leftAlias}.`)) {
            return combined[col.split('.')[1]] === val;
          }
          // bare columns already applied in rowMatches for base table;
          // for join path re-check base
          if (!col.includes('.')) {
            if (combined[col] !== undefined) return combined[col] === val;
            if (combined.__join[col] !== undefined) {
              return combined.__join[col] === val;
            }
          }
          return true;
        });
      });

      // Child-only selects (te.*, a.*, m.*) — return base row, drop join columns.
      // This mirrors production `.select('te.*')` avoiding Run column collisions.
      rows = rows.map((c) => {
        const { __join, ...base } = c;
        void __join;
        if (
          Array.isArray(ctx.selectCols) &&
          ctx.selectCols.some(
            (s) =>
              s === 'te.*' ||
              s === 'a.*' ||
              s === 'm.*' ||
              (typeof s === 'string' && s.endsWith('.*')),
          )
        ) {
          return base;
        }
        return base;
      });
    }

    if (ctx.order) {
      const { col, dir } = ctx.order;
      const orderKey = col.includes('.') ? col.split('.').pop() : col;
      rows = [...rows].sort((a, b) => {
        const av = a[orderKey];
        const bv = b[orderKey];
        if (av === bv) return 0;
        if (av > bv) return dir === 'desc' ? -1 : 1;
        return dir === 'desc' ? 1 : -1;
      });
    }

    if (ctx.limitN != null) rows = rows.slice(0, ctx.limitN);
    return rows;
  }

  return api;
}

/**
 * @param {FakeState} [state]
 */
export function createFakeKnex(state = createFakeState()) {
  /** @type {any} */
  const knex = (tableName) => createQuery(state, tableName);

  knex.__state = state;
  knex.isTransaction = false;

  knex.transaction = async (fn) => {
    // Snapshot tables so throw rolls back mutations (PR-05 snapshot CAS tests).
    const snapshot = JSON.parse(JSON.stringify(state.tables));
    const trx = createFakeKnex(state);
    trx.isTransaction = true;
    trx.transaction = undefined;
    try {
      const result = await fn(trx);
      return result;
    } catch (err) {
      state.tables = snapshot;
      // Keep rawCalls for diagnostics; table data restored.
      throw err;
    }
  };

  knex.raw = async (sql, bindings = []) => {
    state.rawCalls.push({ sql: String(sql), bindings: [...bindings] });
    const sqlNorm = String(sql).replace(/\s+/g, ' ').trim();

    if (/UPDATE runs SET next_event_sequence = LAST_INSERT_ID/i.test(sqlNorm)) {
      const runId = bindings[1];
      const orgId = bindings[2];
      const userId = bindings[3];
      const runs = state.tables.runs || [];
      const run = runs.find(
        (r) =>
          r.run_id === runId && r.org_id === orgId && r.user_id === userId,
      );
      if (!run) {
        return [{ affectedRows: 0 }];
      }
      const next = Number(run.next_event_sequence || 0) + 1;
      run.next_event_sequence = next;
      state.lastInsertId = next;
      if (bindings[0] != null) run.updated_at = bindings[0];
      return [{ affectedRows: 1 }];
    }

    if (/SELECT LAST_INSERT_ID\(\)/i.test(sqlNorm)) {
      return [[{ seq: state.lastInsertId }]];
    }

    throw new Error(`fake knex.raw not implemented for: ${sqlNorm.slice(0, 80)}`);
  };

  knex.destroy = async () => {};
  knex.migrate = {
    latest: async () => {
      throw new Error('fake knex has no migrate.latest');
    },
    rollback: async () => {
      throw new Error('fake knex has no migrate.rollback');
    },
  };

  return knex;
}
