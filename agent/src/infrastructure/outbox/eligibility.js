/**
 * Claim eligibility for concurrent outbox publishers.
 *
 * domain_outbox is generic. Each publisher must claim only rows it owns so
 * unrelated aggregates remain PENDING for their own workers.
 *
 * All SQL fragments are parameterized (no string-concat of user values).
 */

/**
 * @typedef {{
 *   aggregateTypes?: string[],
 *   eventTypes?: string[],
 *   includePayloadRunId?: boolean,
 * }} ClaimEligibility
 */

/**
 * Default eligibility for the RunEventStream outbox publisher:
 * - aggregate_type = 'run', or
 * - non-run rows that intentionally carry payload.runId / payload.run_id
 *
 * @type {Readonly<ClaimEligibility>}
 */
export const RUN_STREAM_CLAIM_ELIGIBILITY = Object.freeze({
  aggregateTypes: Object.freeze(['run']),
  includePayloadRunId: true,
});

/**
 * Normalize and validate an eligibility object.
 * Empty / omitted filters mean "no eligibility restriction" (claim any due row).
 *
 * @param {ClaimEligibility | null | undefined} eligibility
 * @returns {ClaimEligibility}
 */
export function normalizeClaimEligibility(eligibility) {
  if (eligibility == null) return {};
  if (typeof eligibility !== 'object' || Array.isArray(eligibility)) {
    throw new Error('claim eligibility must be an object when provided');
  }

  /** @type {ClaimEligibility} */
  const out = {};

  if (eligibility.aggregateTypes !== undefined) {
    if (!Array.isArray(eligibility.aggregateTypes)) {
      throw new Error('eligibility.aggregateTypes must be an array of non-empty strings');
    }
    const types = eligibility.aggregateTypes.map((t) => {
      if (typeof t !== 'string' || t.trim() === '') {
        throw new Error('eligibility.aggregateTypes entries must be non-empty strings');
      }
      return t.trim();
    });
    // de-dupe preserve order
    out.aggregateTypes = [...new Set(types)];
  }

  if (eligibility.eventTypes !== undefined) {
    if (!Array.isArray(eligibility.eventTypes)) {
      throw new Error('eligibility.eventTypes must be an array of non-empty strings');
    }
    const types = eligibility.eventTypes.map((t) => {
      if (typeof t !== 'string' || t.trim() === '') {
        throw new Error('eligibility.eventTypes entries must be non-empty strings');
      }
      return t.trim();
    });
    out.eventTypes = [...new Set(types)];
  }

  if (eligibility.includePayloadRunId !== undefined) {
    if (typeof eligibility.includePayloadRunId !== 'boolean') {
      throw new Error('eligibility.includePayloadRunId must be a boolean');
    }
    out.includePayloadRunId = eligibility.includePayloadRunId;
  }

  return out;
}

/**
 * Whether eligibility adds any SQL predicate (false = claim all due rows).
 *
 * @param {ClaimEligibility} eligibility
 */
export function hasEligibilityFilter(eligibility) {
  const e = normalizeClaimEligibility(eligibility);
  return Boolean(
    (e.aggregateTypes && e.aggregateTypes.length > 0) ||
      (e.eventTypes && e.eventTypes.length > 0) ||
      e.includePayloadRunId === true,
  );
}

/**
 * Build parameterized SQL fragment + bindings for AND ( ... ).
 * Returns empty sql when no filter (caller must not append AND).
 *
 * @param {ClaimEligibility | null | undefined} eligibility
 * @returns {{ sql: string, bindings: unknown[] }}
 */
export function buildEligibilitySql(eligibility) {
  const e = normalizeClaimEligibility(eligibility);
  /** @type {string[]} */
  const parts = [];
  /** @type {unknown[]} */
  const bindings = [];

  if (e.aggregateTypes && e.aggregateTypes.length > 0) {
    if (e.aggregateTypes.length === 1) {
      parts.push('aggregate_type = ?');
      bindings.push(e.aggregateTypes[0]);
    } else {
      parts.push(
        `aggregate_type IN (${e.aggregateTypes.map(() => '?').join(', ')})`,
      );
      bindings.push(...e.aggregateTypes);
    }
  }

  if (e.eventTypes && e.eventTypes.length > 0) {
    if (e.eventTypes.length === 1) {
      parts.push('event_type = ?');
      bindings.push(e.eventTypes[0]);
    } else {
      parts.push(`event_type IN (${e.eventTypes.map(() => '?').join(', ')})`);
      bindings.push(...e.eventTypes);
    }
  }

  if (e.includePayloadRunId === true) {
    // MySQL JSON: claim non-run rows that intentionally carry a run id.
    parts.push(
      `(
        (
          JSON_EXTRACT(payload_json, '$.runId') IS NOT NULL
          AND JSON_TYPE(JSON_EXTRACT(payload_json, '$.runId')) <> 'NULL'
          AND JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.runId')) <> ''
        )
        OR
        (
          JSON_EXTRACT(payload_json, '$.run_id') IS NOT NULL
          AND JSON_TYPE(JSON_EXTRACT(payload_json, '$.run_id')) <> 'NULL'
          AND JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.run_id')) <> ''
        )
      )`,
    );
  }

  if (parts.length === 0) {
    return { sql: '', bindings: [] };
  }

  // OR across independent eligibility axes so aggregate_type OR payload.runId works.
  // eventTypes, when present, is ANDed with the (aggregate OR payload) group when both exist.
  if (e.eventTypes && e.eventTypes.length > 0 && parts.length > 1) {
    const eventPart = parts.pop();
    // rebuild: (aggregate OR payload...) AND event
    const scopeParts = [];
    if (e.aggregateTypes && e.aggregateTypes.length > 0) {
      scopeParts.push(parts.shift());
    }
    if (e.includePayloadRunId === true) {
      scopeParts.push(parts.shift());
    }
    // parts should be empty; if anything remains, OR them in
    while (parts.length) scopeParts.push(parts.shift());
    const scopeSql =
      scopeParts.length === 0
        ? '1=1'
        : scopeParts.length === 1
          ? scopeParts[0]
          : `(${scopeParts.join(' OR ')})`;
    return {
      sql: `(${scopeSql} AND ${eventPart})`,
      bindings,
    };
  }

  if (parts.length === 1) {
    return { sql: parts[0], bindings };
  }
  return { sql: `(${parts.join(' OR ')})`, bindings };
}

/**
 * In-memory eligibility check (unit tests / fake knex).
 *
 * @param {Record<string, unknown>} row
 * @param {ClaimEligibility | null | undefined} eligibility
 */
export function rowMatchesEligibility(row, eligibility) {
  const e = normalizeClaimEligibility(eligibility);
  if (!hasEligibilityFilter(e)) return true;

  let scopeOk = false;
  let hasScopeAxis = false;

  if (e.aggregateTypes && e.aggregateTypes.length > 0) {
    hasScopeAxis = true;
    if (e.aggregateTypes.includes(String(row.aggregate_type))) {
      scopeOk = true;
    }
  }

  if (e.includePayloadRunId === true) {
    hasScopeAxis = true;
    const payload = parsePayload(row.payload_json);
    const runId = payload.runId ?? payload.run_id;
    if (typeof runId === 'string' && runId.trim() !== '') {
      scopeOk = true;
    }
  }

  if (hasScopeAxis && !scopeOk) return false;

  if (e.eventTypes && e.eventTypes.length > 0) {
    if (!e.eventTypes.includes(String(row.event_type))) return false;
  }

  return true;
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function parsePayload(value) {
  if (value == null) return {};
  if (typeof value === 'object' && !Buffer.isBuffer(value)) {
    return /** @type {Record<string, unknown>} */ (value);
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}
