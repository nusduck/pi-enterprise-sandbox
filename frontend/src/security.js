/**
 * Frontend security helpers — URL allowlist and text sanitization.
 */

/**
 * Validate that a download/artifact URL is a same-origin relative `/api/...` path.
 * Rejects absolute URLs, protocol-relative URLs, javascript:/data: schemes, etc.
 *
 * @param {unknown} url
 * @returns {boolean}
 */
export function isAllowedApiUrl(url) {
  if (typeof url !== 'string' || !url) return false;

  // Must be a relative same-origin API path
  if (!url.startsWith('/api/')) return false;

  // Protocol-relative or double-slash tricks
  if (url.startsWith('//') || url.includes('://')) return false;

  // Reject control chars, whitespace, quotes (attribute breakout)
  if (/[\u0000-\u001F\u007F\s<>"'`]/.test(url)) return false;

  // Reject scheme-like prefixes that somehow slipped past (defense in depth)
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) return false;

  // Path must stay under /api/ after normalization (block /api/../escape)
  try {
    const parsed = new URL(url, 'http://local.invalid');
    if (parsed.origin !== 'http://local.invalid') return false;
    if (!parsed.pathname.startsWith('/api/')) return false;
  } catch {
    return false;
  }

  return true;
}

/**
 * Return the URL if allowed, otherwise null.
 * @param {unknown} url
 * @returns {string|null}
 */
export function safeApiUrl(url) {
  return isAllowedApiUrl(url) ? url : null;
}
