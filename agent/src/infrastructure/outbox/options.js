/**
 * Positive option validation for OutboxRepository / OutboxPublisher.
 */

/**
 * @param {string} name
 * @param {unknown} value
 * @param {{ min?: number, max?: number, allowZero?: boolean }} [opts]
 * @returns {number}
 */
export function requirePositiveInteger(name, value, opts = {}) {
  const min = opts.allowZero ? 0 : (opts.min ?? 1);
  const max = opts.max;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw new Error(
      `${name} must be an integer >= ${min}${max != null ? ` and <= ${max}` : ''}`,
    );
  }
  if (max != null && value > max) {
    throw new Error(`${name} must be an integer >= ${min} and <= ${max}`);
  }
  return value;
}

/**
 * @param {string} name
 * @param {unknown} value
 * @param {{ min?: number, max?: number }} [opts]
 * @returns {number}
 */
export function requirePositiveDurationMs(name, value, opts = {}) {
  const min = opts.min ?? 1;
  const max = opts.max;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
    throw new Error(
      `${name} must be a finite number >= ${min}${max != null ? ` and <= ${max}` : ''}`,
    );
  }
  if (max != null && value > max) {
    throw new Error(`${name} must be a finite number >= ${min} and <= ${max}`);
  }
  // durations may be non-integer ms; still require positive
  return value;
}

/**
 * Clamp claim/list limit after validating positive integer.
 *
 * @param {unknown} limit
 * @param {number} defaultLimit
 * @param {number} maxLimit
 * @param {string} [name]
 */
export function resolveBatchLimit(limit, defaultLimit, maxLimit, name = 'limit') {
  if (limit === undefined || limit === null) {
    return defaultLimit;
  }
  const n = requirePositiveInteger(name, limit, { min: 1, max: maxLimit });
  return n;
}
