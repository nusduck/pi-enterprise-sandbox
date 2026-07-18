/**
 * Deterministic A2A task id from (org, client, run) so mapping retries
 * never invent a second task for the same internal Run.
 *
 * Output is 26 Crockford Base32 chars (ULID alphabet) but is NOT time-ordered.
 */

import { createHash } from 'node:crypto';
import { CROCKFORD_ALPHABET } from '../../domain/shared/ulid.js';

/**
 * @param {string} orgId
 * @param {string} clientId
 * @param {string} runId
 * @returns {string}
 */
export function deterministicA2aTaskId(orgId, clientId, runId) {
  const material = `a2a-task-v1:${String(orgId)}:${String(clientId)}:${String(runId)}`;
  const digest = createHash('sha256').update(material, 'utf8').digest();
  // 130 bits → 26 × 5-bit Crockford chars
  let bits = BigInt(`0x${digest.subarray(0, 17).toString('hex')}`);
  let out = '';
  for (let i = 0; i < 26; i += 1) {
    out = CROCKFORD_ALPHABET[Number(bits & 31n)] + out;
    bits >>= 5n;
  }
  return out;
}
