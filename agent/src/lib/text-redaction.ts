/** Shared secret + host-path redaction for registry, MCP, and runtime projections. */

export const SECRET_PATTERNS = Object.freeze([
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,
  // Field-style secrets. Keep compound forms (access_token, client_secret,
  // x-api-key) ahead of bare `token`/`secret` so durable paths match the
  // projector INLINE set rather than leaking through the shorter alternation.
  /\b(api[_-]?key|x-api-key|x-auth-token|access[_-]?token|refresh[_-]?token|client[_-]?secret|token|secret|password|authorization)\s*[:=]\s*[^\s,;]+/gi,
  // Cookie headers often embed session tokens.
  /\bCookie\s*:\s*[^\n\r]+/gi,
  // Provider-style live keys (OpenAI sk-…).
  /\bsk-[A-Za-z0-9]{10,}\b/g,
  // Any URI userinfo may carry credentials. Include empty usernames for
  // password-only Redis URLs such as redis://:password@host/0.
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]*:[^\s/@]+@[^\s]+/gi,
]);

export function redactSecretText(value) {
  let text = String(value);
  for (const pattern of SECRET_PATTERNS) {
    // Patterns without a capture group pass the match offset as the 2nd
    // callback arg (a number). Only treat a string capture as a field name.
    text = text.replace(pattern, (_match, key) =>
      typeof key === 'string' ? `${key}=[REDACTED]` : '[REDACTED]',
    );
  }
  return text;
}

/**
 * Truncate to at most `maxLength` Unicode code points. Plain `String#slice`
 * counts UTF-16 code units and can split a surrogate pair (e.g. an emoji),
 * producing an unpaired surrogate in the output. Iterating `for...of` walks
 * code points instead, so the cut always lands on a character boundary.
 *
 * @param value
 * @param maxLength
 * @returns {{ text: string, truncated: boolean }}
 */
export function safeSlice(value: string, maxLength: number) {
  const source = String(value ?? '');
  if (source.length <= maxLength) {
    return { text: source, truncated: false };
  }
  let result = '';
  let count = 0;
  for (const ch of source) {
    if (count >= maxLength) {
      return { text: result, truncated: true };
    }
    result += ch;
    count += 1;
  }
  return { text: result, truncated: false };
}
