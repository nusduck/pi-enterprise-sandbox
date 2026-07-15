/** Shared redaction patterns for audit, event, and ledger projections. */
export const SECRET_PATTERNS = Object.freeze([
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,
  /\b(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*[^\s,;]+/gi,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?)?:?\/\/[^\s/@:]+:[^\s/@]+@[^\s]+/gi,
]);

export function redactSecretText(value) {
  let text = String(value);
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (match, key) =>
      key ? `${key}=[REDACTED]` : '[REDACTED]',
    );
  }
  return text;
}
