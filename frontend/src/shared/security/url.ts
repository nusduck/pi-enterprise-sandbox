/**
 * Frontend security helpers — URL allowlist and text sanitization.
 */

/**
 * Validate that a download/artifact URL is a same-origin relative `/api/...` path.
 * Rejects absolute URLs, protocol-relative URLs, javascript:/data: schemes, etc.
 */
export function isAllowedApiUrl(url: unknown): boolean {
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

/** Return the URL if allowed, otherwise null. */
export function safeApiUrl(url: unknown): string | null {
  return isAllowedApiUrl(url) ? (url as string) : null;
}

/**
 * Safe HTML `download` attribute value.
 *
 * Empty `download=""` makes browsers ignore Content-Disposition and save as the
 * URL's last path segment (`artifact-download`, no extension).
 */
export function downloadAttrName(name: unknown, path?: unknown): string {
  const basename = (value: unknown): string => {
    const raw = typeof value === 'string' ? value : '';
    const base = raw.split(/[/\\]/).pop() || '';
    const cleaned = base
      .replace(/[\u0000-\u001F\u007F]/g, '')
      .replace(/["<>]/g, '_')
      .trim();
    return !cleaned || cleaned === '.' || cleaned === '..' ? '' : cleaned;
  };
  const ext = /\.[A-Za-z0-9]{1,8}$/;
  const cleaned = basename(name) || basename(path);
  if (!cleaned) return 'download';
  // submit_artifact names are user-facing titles ("随机 Markdown 文档") whose
  // extension lives only in the workspace path. A `download` value overrides
  // Content-Disposition, so borrow that extension or the file saves unopenable.
  if (!ext.test(cleaned)) {
    const fromPath = basename(path).match(ext);
    if (fromPath) return `${cleaned.slice(0, 200 - fromPath[0].length)}${fromPath[0]}`;
  }
  return cleaned.slice(0, 200);
}
