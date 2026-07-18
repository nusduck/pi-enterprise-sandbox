/**
 * In-memory knex-like fake for OutboxRepository unit tests.
 * Supports parameterized raw SQL used by claim/reclaim/publish paths,
 * including concurrent claim semantics via FOR UPDATE SKIP LOCKED simulation
 * and claim eligibility filters.
 */

import { rowMatchesEligibility } from '../../src/infrastructure/outbox/eligibility.js';

/**
 * @typedef {object} FakeState
 * @property {Record<string, Record<string, unknown>[]>} tables
 * @property {Array<{ sql: string, bindings: unknown[] }>} rawCalls
 * @property {Set<string>} lockedOutboxIds
 * @property {number} claimSelectCalls
 * @property {import('../../src/infrastructure/outbox/eligibility.js').ClaimEligibility | null | undefined} lastClaimEligibility
 */

/**
 * @returns {FakeState}
 */
export function createFakeState() {
  return {
    tables: Object.create(null),
    rawCalls: [],
    lockedOutboxIds: new Set(),
    claimSelectCalls: 0,
    lastClaimEligibility: undefined,
  };
}

/**
 * @param {string} sql
 */
function normSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

/**
 * Infer eligibility from claim/reclaim SQL + bindings for in-memory filtering.
 * Mirrors buildEligibilitySql binding order after the fixed prefix bindings.
 *
 * @param {string} sqlNorm
 * @param {unknown[]} bindings
 * @param {number} fixedPrefixLen bindings before eligibility
 * @returns {import('../../src/infrastructure/outbox/eligibility.js').ClaimEligibility | null}
 */
export function inferEligibilityFromSql(sqlNorm, bindings, fixedPrefixLen) {
  const hasAggEq = /aggregate_type = \?/.test(sqlNorm);
  const hasAggIn = /aggregate_type IN \(/.test(sqlNorm);
  const hasEvtEq = /event_type = \?/.test(sqlNorm);
  const hasEvtIn = /event_type IN \(/.test(sqlNorm);
  const hasPayloadRun =
    /JSON_EXTRACT\(payload_json, '\$\.runId'\)/i.test(sqlNorm) ||
    /JSON_EXTRACT\(payload_json, "\$\.runId"\)/i.test(sqlNorm);

  if (!hasAggEq && !hasAggIn && !hasEvtEq && !hasEvtIn && !hasPayloadRun) {
    return null;
  }

  /** @type {import('../../src/infrastructure/outbox/eligibility.js').ClaimEligibility} */
  const elig = {};
  let i = fixedPrefixLen;

  if (hasAggIn) {
    const m = sqlNorm.match(/aggregate_type IN \(([^)]+)\)/i);
    const n = m ? m[1].split(',').length : 0;
    elig.aggregateTypes = /** @type {string[]} */ (
      bindings.slice(i, i + n).map(String)
    );
    i += n;
  } else if (hasAggEq) {
    elig.aggregateTypes = [String(bindings[i])];
    i += 1;
  }

  if (hasEvtIn) {
    const m = sqlNorm.match(/event_type IN \(([^)]+)\)/i);
    const n = m ? m[1].split(',').length : 0;
    elig.eventTypes = /** @type {string[]} */ (
      bindings.slice(i, i + n).map(String)
    );
    i += n;
  } else if (hasEvtEq) {
    // event_type = ? may appear after aggregate; binding is next
    // When only event filter, binding is at i.
    elig.eventTypes = [String(bindings[i])];
    i += 1;
  }

  if (hasPayloadRun) {
    elig.includePayloadRunId = true;
  }

  return elig;
}

/**
 * @param {FakeState} state
 * @param {string} tableName
 */
function createQuery(state, tableName) {
  /** @type {{ type: string, filters: Array<[string, unknown]>, limitN?: number, insertRow?: Record<string, unknown>, updates?: Record<string, unknown> }} */
  const ctx = { type: 'select', filters: [] };

  const ensureTable = (name) => {
    if (!state.tables[name]) state.tables[name] = [];
    return state.tables[name];
  };

  const rowMatches = (row) =>
    ctx.filters.every(([col, val]) => row[col] === val);

  function run() {
    const table = ensureTable(tableName);
    if (ctx.type === 'insert') {
      table.push({ ...ctx.insertRow });
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
    let rows = table.filter(rowMatches);
    if (ctx.limitN != null) rows = rows.slice(0, ctx.limitN);
    return rows;
  }

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
      return Promise.resolve(run()).then((rows) =>
        Array.isArray(rows) ? rows[0] : rows,
      );
    },
    then(resolve, reject) {
      return Promise.resolve(run()).then(resolve, reject);
    },
  };
  return api;
}

/**
 * @param {FakeState} [state]
 */
export function createFakeOutboxKnex(state = createFakeState()) {
  /** @type {any} */
  const knex = (tableName) => createQuery(state, tableName);

  knex.__state = state;
  knex.isTransaction = false;

  knex.transaction = async (fn) => {
    const trx = createFakeOutboxKnex(state);
    trx.isTransaction = true;
    trx.transaction = undefined;
    const held = new Set();
    const baseRaw = trx.raw;
    trx.raw = async (sql, bindings = []) => {
      const result = await baseRaw(sql, bindings);
      const n = normSql(sql);
      if (/FOR UPDATE SKIP LOCKED/i.test(n) && Array.isArray(result?.[0])) {
        for (const row of result[0]) {
          held.add(String(row.outbox_id));
        }
      }
      return result;
    };
    try {
      const out = await fn(trx);
      for (const id of held) state.lockedOutboxIds.delete(id);
      return out;
    } catch (err) {
      for (const id of held) state.lockedOutboxIds.delete(id);
      throw err;
    }
  };

  knex.raw = async (sql, bindings = []) => {
    state.rawCalls.push({ sql: String(sql), bindings: [...bindings] });
    const n = normSql(sql);
    const table = state.tables.domain_outbox || (state.tables.domain_outbox = []);

    // claim SELECT … FOR UPDATE SKIP LOCKED
    // bindings: status, now, ...elig, limit
    if (/FOR UPDATE SKIP LOCKED/i.test(n) && /^SELECT /i.test(n)) {
      state.claimSelectCalls += 1;
      const status = bindings[0];
      const now = bindings[1];
      const limit = Number(bindings[bindings.length - 1] ?? 50);
      const elig = inferEligibilityFromSql(n, bindings, 2);
      state.lastClaimEligibility = elig;

      const due = table
        .filter((row) => {
          if (row.status !== status) return false;
          if (state.lockedOutboxIds.has(String(row.outbox_id))) return false;
          if (row.next_attempt_at != null && String(row.next_attempt_at) > String(now)) {
            return false;
          }
          if (elig && !rowMatchesEligibility(row, elig)) return false;
          return true;
        })
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
        .slice(0, limit);

      for (const row of due) {
        state.lockedOutboxIds.add(String(row.outbox_id));
      }
      return [due.map((r) => ({ ...r })), []];
    }

    // listPending / listForRecovery SELECT
    if (/^SELECT /i.test(n) && /FROM domain_outbox/i.test(n)) {
      // Detect recovery shape: two status predicates
      const isRecovery =
        (n.match(/status = \?/g) || []).length >= 2 &&
        /claimed_at < \?/i.test(n);

      if (isRecovery) {
        // bindings: PENDING, now, PUBLISHING, cutoff, ...elig, limit
        const pendingStatus = bindings[0];
        const now = bindings[1];
        const publishingStatus = bindings[2];
        const cutoff = bindings[3];
        const limit = Number(bindings[bindings.length - 1]);
        const elig = inferEligibilityFromSql(n, bindings, 4);
        const rows = table
          .filter((row) => {
            let match = false;
            if (row.status === pendingStatus) {
              if (row.next_attempt_at == null || String(row.next_attempt_at) <= String(now)) {
                match = true;
              }
            } else if (row.status === publishingStatus) {
              if (row.claimed_at != null && String(row.claimed_at) < String(cutoff)) {
                match = true;
              }
            }
            if (!match) return false;
            if (elig && !rowMatchesEligibility(row, elig)) return false;
            return true;
          })
          .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
          .slice(0, limit)
          .map((r) => ({ ...r }));
        return [rows, []];
      }

      // listPending: status, now, ...elig, limit
      const status = bindings[0];
      const now = bindings[1];
      const limit = Number(bindings[bindings.length - 1]);
      const elig = inferEligibilityFromSql(n, bindings, 2);
      const rows = table
        .filter((row) => {
          if (row.status !== status) return false;
          if (row.next_attempt_at != null && String(row.next_attempt_at) > String(now)) {
            return false;
          }
          if (elig && !rowMatchesEligibility(row, elig)) return false;
          return true;
        })
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
        .slice(0, limit)
        .map((r) => ({ ...r }));
      return [rows, []];
    }

    // UPDATE domain_outbox …
    if (/^UPDATE domain_outbox/i.test(n)) {
      // reclaim stale PUBLISHING — bindings: PENDING, now, PUBLISHING, cutoff, ...elig
      if (
        /SET status = \?,\s*claim_token = NULL,\s*claimed_at = NULL,\s*next_attempt_at = \?/i.test(
          n,
        ) &&
        bindings[2] === 'PUBLISHING'
      ) {
        const newStatus = bindings[0];
        const nextAttempt = bindings[1];
        const cutoff = bindings[3];
        const elig = inferEligibilityFromSql(n, bindings, 4);
        let affected = 0;
        for (const row of table) {
          if (
            row.status === 'PUBLISHING' &&
            row.claimed_at != null &&
            String(row.claimed_at) < String(cutoff) &&
            (!elig || rowMatchesEligibility(row, elig))
          ) {
            row.status = newStatus;
            row.claim_token = null;
            row.claimed_at = null;
            row.next_attempt_at = nextAttempt;
            affected += 1;
          }
        }
        return [{ affectedRows: affected }];
      }

      // claim mark PUBLISHING
      if (
        /SET status = \?,\s*claim_token = \?,\s*claimed_at = \?,\s*attempts = \?/i.test(
          n,
        )
      ) {
        const [
          newStatus,
          claimToken,
          claimedAt,
          attempts,
          outboxId,
          expectedStatus,
        ] = bindings;
        const row = table.find((r) => r.outbox_id === outboxId);
        if (!row || row.status !== expectedStatus) {
          return [{ affectedRows: 0 }];
        }
        row.status = newStatus;
        row.claim_token = claimToken;
        row.claimed_at = claimedAt;
        row.attempts = attempts;
        row.next_attempt_at = null;
        return [{ affectedRows: 1 }];
      }

      // markPublished
      if (
        /SET status = \?,\s*published_at = \?/i.test(n) &&
        bindings.includes('PUBLISHED')
      ) {
        const [newStatus, publishedAt, outboxId, claimToken, expectedStatus] =
          bindings;
        const row = table.find((r) => r.outbox_id === outboxId);
        if (
          !row ||
          row.claim_token !== claimToken ||
          row.status !== expectedStatus
        ) {
          return [{ affectedRows: 0 }];
        }
        row.status = newStatus;
        row.published_at = publishedAt;
        row.claim_token = null;
        row.claimed_at = null;
        row.last_error = null;
        row.next_attempt_at = null;
        return [{ affectedRows: 1 }];
      }

      // markPendingForRetry
      if (
        /SET status = \?,\s*claim_token = NULL,\s*claimed_at = NULL,\s*next_attempt_at = \?,\s*last_error = \?/i.test(
          n,
        )
      ) {
        const [
          newStatus,
          nextAttemptAt,
          lastError,
          outboxId,
          claimToken,
          expectedStatus,
        ] = bindings;
        const row = table.find((r) => r.outbox_id === outboxId);
        if (
          !row ||
          row.claim_token !== claimToken ||
          row.status !== expectedStatus
        ) {
          return [{ affectedRows: 0 }];
        }
        row.status = newStatus;
        row.claim_token = null;
        row.claimed_at = null;
        row.next_attempt_at = nextAttemptAt;
        row.last_error = lastError;
        return [{ affectedRows: 1 }];
      }

      // markFailed
      if (
        /SET status = \?,\s*claim_token = NULL,\s*claimed_at = NULL,\s*last_error = \?/i.test(
          n,
        ) &&
        bindings.includes('FAILED')
      ) {
        const [newStatus, lastError, outboxId, claimToken, expectedStatus] =
          bindings;
        const row = table.find((r) => r.outbox_id === outboxId);
        if (
          !row ||
          row.claim_token !== claimToken ||
          row.status !== expectedStatus
        ) {
          return [{ affectedRows: 0 }];
        }
        row.status = newStatus;
        row.claim_token = null;
        row.claimed_at = null;
        row.last_error = lastError;
        row.next_attempt_at = null;
        return [{ affectedRows: 1 }];
      }

      throw new Error(`fake raw UPDATE not matched: ${n.slice(0, 120)}`);
    }

    throw new Error(`fake knex.raw not implemented for: ${n.slice(0, 100)}`);
  };

  knex.destroy = async () => {};
  return knex;
}

/**
 * Seed a minimal PENDING outbox row.
 * @param {FakeState} state
 * @param {Partial<Record<string, unknown>> & { outbox_id: string }} row
 */
export function seedOutboxRow(state, row) {
  if (!state.tables.domain_outbox) state.tables.domain_outbox = [];
  const outboxId = row.outbox_id;
  state.tables.domain_outbox.push({
    aggregate_type: 'run',
    aggregate_id: '01K0G2PAV8FPMVC9QHJG7JPN53',
    event_type: 'run.started',
    payload_json: JSON.stringify({
      eventId: outboxId,
      sequence: 1,
      runId: '01K0G2PAV8FPMVC9QHJG7JPN53',
    }),
    status: 'PENDING',
    attempts: 0,
    claim_token: null,
    claimed_at: null,
    next_attempt_at: null,
    last_error: null,
    created_at: '2026-07-18 04:31:22.000',
    published_at: null,
    ...row,
  });
}
