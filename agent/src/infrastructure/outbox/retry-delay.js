/**
 * Exponential, bounded backoff for outbox republish attempts.
 */

/**
 * Delay in ms after `attempts` completed tries (attempts is post-increment claim count).
 * attempt 1 → base, 2 → 2*base, 3 → 4*base, … capped at maxDelayMs.
 *
 * @param {number} attempts
 * @param {{ baseDelayMs?: number, maxDelayMs?: number }} [opts]
 * @returns {number}
 */
export function computeRetryDelayMs(attempts, opts = {}) {
  const base = opts.baseDelayMs ?? 1_000;
  const max = opts.maxDelayMs ?? 300_000;
  const n = Math.max(1, Math.floor(Number(attempts) || 1));
  // 2^(n-1) * base, avoid overflow
  const exp = Math.min(n - 1, 30);
  const raw = base * 2 ** exp;
  return Math.min(max, Math.max(base, raw));
}
