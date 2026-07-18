/**
 * Map domain_outbox snake_case rows ↔ domain camelCase DomainOutbox shapes.
 */

import {
  formatDateTime,
  parseJsonColumn,
} from '../mysql/row-mappers.js';

/**
 * @param {Record<string, unknown>} row
 */
export function mapDomainOutbox(row) {
  return {
    outboxId: String(row.outbox_id),
    aggregateType: String(row.aggregate_type),
    aggregateId: String(row.aggregate_id),
    eventType: String(row.event_type),
    payloadJson: parseJsonColumn(row.payload_json),
    status: String(row.status),
    attempts: Number(row.attempts ?? 0),
    claimToken: row.claim_token == null ? null : String(row.claim_token),
    claimedAt: formatDateTime(row.claimed_at),
    nextAttemptAt: formatDateTime(row.next_attempt_at),
    lastError: row.last_error == null ? null : String(row.last_error),
    createdAt: formatDateTime(row.created_at),
    publishedAt: formatDateTime(row.published_at),
  };
}
