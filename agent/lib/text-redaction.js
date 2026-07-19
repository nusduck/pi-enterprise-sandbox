/** Shared secret + host-path redaction for registry, MCP, and runtime projections. */

export const SECRET_PATTERNS = Object.freeze([
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,
  /\b(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*[^\s,;]+/gi,
  // Any URI userinfo may carry credentials. Include empty usernames for
  // password-only Redis URLs such as redis://:password@host/0.
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]*:[^\s/@]+@[^\s]+/gi,
]);

export function redactSecretText(value) {
  let text = String(value);
  for (const pattern of SECRET_PATTERNS) {
    // Patterns without a capture group pass the match offset as the 2nd
    // callback arg (a number). Only treat a string capture as a field name.
    text = text.replace(pattern, (match, key) =>
      typeof key === 'string' ? `${key}=[REDACTED]` : '[REDACTED]',
    );
  }
  return text;
}

/** Canonical logical skill root that must survive host-path redaction. */
export const LOGICAL_SKILL_ROOTS = Object.freeze(['/home/sandbox/skill']);

const PLACEHOLDER = Object.freeze({
  url: '\uE000U',
  root: '\uE000R',
  end: '\uE001',
});

/** Path continuation after a logical root (segments may include dot-directories and extensions). */
const PATH_CONTINUE = '(?:/[^\\s]+)*';

const PATH_SEGMENT = '[^/\\s]+';

/** Generic absolute POSIX path — must not follow a relative segment (e.g. a/b). */
const GENERIC_POSIX_PATH = new RegExp(
  `(?<![A-Za-z0-9])\\/(?:${PATH_SEGMENT}(?:\\/${PATH_SEGMENT})*)`,
  'g',
);

const WINDOWS_PATH = /[A-Za-z]:[\\/][^\s]+/g;

/** Trailing punctuation after a path token (not part of dot-directories or file extensions). */
const TRAILING_PATH_PUNCT = /[.,;:!?)\]}>"']+$/;

function redactPathToken(match) {
  const trimmed = match.replace(TRAILING_PATH_PUNCT, '');
  const suffix = match.slice(trimmed.length);
  return `[redacted-path]${suffix}`;
}

/** Allow dots in host/path; credential URLs are handled by secret redaction afterward. */
const SCHEME_URL = /[a-z][a-z0-9+.-]*:\/\/[^\s,;:!?)\]}>"']+/gi;

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function protectMatches(text, pattern, prefix, saved) {
  return text.replace(pattern, (match) => {
    const id = saved.length;
    saved.push(match);
    return `${prefix}${id}${PLACEHOLDER.end}`;
  });
}

function restoreMatches(text, prefix, saved) {
  return text.replace(
    new RegExp(`${escapeRegExp(prefix)}(\\d+)${escapeRegExp(PLACEHOLDER.end)}`, 'g'),
    (_match, index) => saved[Number(index)] ?? '[redacted-path]',
  );
}

/** Strip accidental absolute host paths embedded in free-text fields. */
export function redactEmbeddedHostPaths(value) {
  if (value == null) return '';
  let text = String(value);

  const savedUrls = [];
  text = protectMatches(text, SCHEME_URL, PLACEHOLDER.url, savedUrls);

  const savedRoots = [];
  const roots = [...LOGICAL_SKILL_ROOTS].sort((a, b) => b.length - a.length);
  for (const root of roots) {
    const pattern = new RegExp(`${escapeRegExp(root)}${PATH_CONTINUE}`, 'g');
    text = protectMatches(text, pattern, PLACEHOLDER.root, savedRoots);
  }

  text = text.replace(GENERIC_POSIX_PATH, redactPathToken);
  text = text.replace(WINDOWS_PATH, redactPathToken);

  text = restoreMatches(text, PLACEHOLDER.root, savedRoots);
  text = restoreMatches(text, PLACEHOLDER.url, savedUrls);

  return text;
}

/**
 * Apply secret + host-path redaction, then optional length clamp.
 * @param {unknown} value
 * @param {number} [max]
 */
export function sanitizeUntrustedText(value, max) {
  if (value == null) return undefined;
  let text = redactSecretText(redactEmbeddedHostPaths(String(value))).trim();
  if (!text) return undefined;
  if (max != null && Number.isFinite(max) && max > 0 && text.length > max) {
    return `${text.slice(0, max - 1)}…`;
  }
  return text;
}
