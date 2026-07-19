import { createHash } from 'node:crypto';
import { redactSecretText } from './secret-patterns.js';

const DEFAULT_MAX_STRING_BYTES = 512;
const SENSITIVE_KEY = /(?:token|secret|password|authorization|api[_-]?key|cookie)/i;

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

/**
 * Return a bounded, non-sensitive projection for tool ledger/SSE payloads.
 * The original arguments remain available to the in-process tool executor.
 */
export function summarizeToolArguments(
  toolName,
  args,
  { maxStringBytes = DEFAULT_MAX_STRING_BYTES } = {},
) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { value: String(args ?? '').slice(0, maxStringBytes) };
  }

  const out = {};
  for (const [key, value] of Object.entries(args)) {
    if (SENSITIVE_KEY.test(key)) {
      out[key] = '[redacted]';
      continue;
    }
    if (typeof value === 'string') {
      const safeValue = redactSecretText(value);
      const bytes = byteLength(value);
      const alwaysHash = toolName === 'skill_edit' && key === 'content';
      if (alwaysHash || bytes > maxStringBytes) {
        if (
          key === 'content' ||
          key === 'code' ||
          key === 'old_string' ||
          key === 'new_string'
        ) {
          out[`${key}_bytes`] = bytes;
          out[`${key}_sha256`] = digest(value);
          continue;
        }
        out[key] = safeValue.slice(0, maxStringBytes);
        out[`${key}_bytes`] = bytes;
        out[`${key}_sha256`] = digest(value);
        out[`${key}_truncated`] = true;
        continue;
      }
      out[key] = safeValue;
      continue;
    }
    if (value == null || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
      continue;
    }

    let encoded;
    try {
      encoded = JSON.stringify(value);
    } catch {
      encoded = '';
    }
    out[key] = '[omitted]';
    if (encoded) {
      out[`${key}_bytes`] = byteLength(encoded);
      out[`${key}_sha256`] = digest(encoded);
    }
  }
  return out;
}
