/**
 * Minimal, dependency-free five-field cron evaluator.
 *
 * Scheduling stays minute-granular by design. The evaluator uses Intl's IANA
 * timezone database and walks UTC minutes, so daylight-saving transitions are
 * handled by the platform rather than by server-local wall-clock arithmetic.
 */

import { ValidationError } from './errors.js';

const FIELD_SPECS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 7 },
];

function formatterFor(timeZone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  });
}

/** @param {unknown} value */
export function assertTimeZone(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ValidationError('timezone must be an IANA timezone');
  }
  const timeZone = value.trim();
  if (timeZone.length > 64) {
    throw new ValidationError('timezone exceeds max length 64');
  }
  try {
    formatterFor(timeZone);
  } catch {
    throw new ValidationError('timezone must be a valid IANA timezone');
  }
  return timeZone;
}

function parseNumber(value, spec) {
  if (!/^\d+$/.test(value)) {
    throw new ValidationError(`Invalid ${spec.name} cron value`);
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < spec.min || number > spec.max) {
    throw new ValidationError(
      `${spec.name} must be between ${spec.min} and ${spec.max}`,
    );
  }
  return number;
}

function parseField(raw, spec) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new ValidationError(`Cron ${spec.name} field is required`);
  }
  const values = new Set();
  for (const item of raw.split(',')) {
    const piece = item.trim();
    if (!piece) throw new ValidationError(`Invalid ${spec.name} cron list`);
    const [base, stepRaw] = piece.split('/');
    if (piece.split('/').length > 2) {
      throw new ValidationError(`Invalid ${spec.name} cron step`);
    }
    const step = stepRaw == null ? 1 : parseNumber(stepRaw, {
      ...spec,
      min: 1,
    });
    let from = spec.min;
    let to = spec.max;
    if (base !== '*') {
      const range = base.split('-');
      if (range.length === 1) {
        from = parseNumber(range[0], spec);
        to = from;
      } else if (range.length === 2) {
        from = parseNumber(range[0], spec);
        to = parseNumber(range[1], spec);
        if (to < from) {
          throw new ValidationError(`Invalid ${spec.name} cron range`);
        }
      } else {
        throw new ValidationError(`Invalid ${spec.name} cron field`);
      }
    }
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return { values, wildcard: raw.trim() === '*' };
}

/**
 * @param expression
 * @returns {{ expression: string, minute: object, hour: object, dayOfMonth: object, month: object, dayOfWeek: object }}
 */
export function parseCronExpression(expression: unknown) {
  if (typeof expression !== 'string' || !expression.trim()) {
    throw new ValidationError('cronExpression is required');
  }
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new ValidationError('cronExpression must have exactly five fields');
  }
  const parsed = fields.map((field, index) => parseField(field, FIELD_SPECS[index]));
  return {
    expression: fields.join(' '),
    minute: parsed[0],
    hour: parsed[1],
    dayOfMonth: parsed[2],
    month: parsed[3],
    dayOfWeek: parsed[4],
  };
}

function zonedParts(date, timeZone, formatter = null) {
  const parts = (formatter || formatterFor(timeZone)).formatToParts(date);
  const get = (type) => Number(parts.find((part) => part.type === type)?.value);
  const weekdayName = parts.find((part) => part.type === 'weekday')?.value;
  const dayOfWeek = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  }[weekdayName || ''];
  return {
    minute: get('minute'),
    hour: get('hour'),
    dayOfMonth: get('day'),
    month: get('month'),
    dayOfWeek,
  };
}

/** @param {ReturnType<typeof parseCronExpression>} cron */
export function cronMatches(cron, date, timeZone, formatter = null) {
  const value = zonedParts(date, timeZone, formatter);
  if (!cron.minute.values.has(value.minute) || !cron.hour.values.has(value.hour)) {
    return false;
  }
  if (!cron.month.values.has(value.month)) return false;
  const dayOfWeekMatch =
    cron.dayOfWeek.values.has(value.dayOfWeek) ||
    (value.dayOfWeek === 0 && cron.dayOfWeek.values.has(7));
  const dayOfMonthMatch = cron.dayOfMonth.values.has(value.dayOfMonth);
  // Traditional cron uses OR when both day fields are constrained.
  const dayMatches = cron.dayOfMonth.wildcard
    ? dayOfWeekMatch
    : cron.dayOfWeek.wildcard
      ? dayOfMonthMatch
      : dayOfMonthMatch || dayOfWeekMatch;
  return dayMatches;
}

/**
 * Find the next matching minute strictly after `after`.
 * A 370-day ceiling makes invalid/unreachable combinations fail predictably.
 */
export function nextCronOccurrence(expression, timeZone, after = new Date()) {
  const cron =
    typeof expression === 'string' ? parseCronExpression(expression) : expression;
  const zone = assertTimeZone(timeZone);
  const start = new Date(after);
  if (Number.isNaN(start.getTime())) {
    throw new ValidationError('after must be a valid timestamp');
  }
  const candidate = new Date(start.getTime());
  const formatter = formatterFor(zone);
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  const maxMinutes = 370 * 24 * 60;
  for (let i = 0; i < maxMinutes; i += 1) {
    if (cronMatches(cron, candidate, zone, formatter)) return new Date(candidate);
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }
  throw new ValidationError('cronExpression has no occurrence in the next 370 days');
}

/** @param {unknown} value */
export function parseRunAt(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ValidationError('runAt is required for a one-time schedule');
  }
  const text = value.trim();
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(text)) {
    throw new ValidationError('runAt must include a UTC offset');
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    throw new ValidationError('runAt must be a valid ISO timestamp');
  }
  return parsed;
}

/** @param {Date | string | null | undefined} value */
export function toScheduleIso(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
