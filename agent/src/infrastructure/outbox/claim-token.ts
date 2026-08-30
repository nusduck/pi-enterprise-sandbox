/**
 * Generate a unique claim token (CHAR(26) Crockford-ish) for outbox claims.
 */

import { randomBytes } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * @returns {string} 26-char uppercase token suitable for domain_outbox.claim_token
 */
export function generateClaimToken() {
  const bytes = randomBytes(26);
  let out = '';
  for (let i = 0; i < 26; i += 1) {
    out += CROCKFORD[bytes[i] % 32];
  }
  return out;
}
