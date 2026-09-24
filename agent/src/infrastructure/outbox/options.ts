/**
 * Positive option validation for OutboxRepository / OutboxPublisher.
 */

/**
 * @param name
 * @param value
 * @param [opts]
 * @returns {number}
 */
export function requirePositiveInteger(name: string, value: unknown, opts: { min?: number, max?: number, allowZero?: boolean } = {}) {
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
 * @param name
 * @param value
 * @param [opts]
 * @returns {number}
 */
export function requirePositiveDurationMs(name: string, value: unknown, opts: { min?: number, max?: number } = {}) {
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
 * @param limit
 * @param defaultLimit
 * @param maxLimit
 * @param [name]
 */
export function resolveBatchLimit(limit: unknown, defaultLimit: number, maxLimit: number, name: string = 'limit') {
  if (limit === undefined || limit === null) {
    return defaultLimit;
  }
  const n = requirePositiveInteger(name, limit, { min: 1, max: maxLimit });
  return n;
}
