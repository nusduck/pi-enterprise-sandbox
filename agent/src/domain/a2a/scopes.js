/**
 * A2A API credential scopes (plan §20.7).
 */

export const A2A_SCOPES = Object.freeze({
  INVOKE: 'agent.invoke',
  READ: 'agent.read',
  CANCEL: 'agent.cancel',
  ARTIFACT_READ: 'artifact.read',
});

export const ALL_A2A_SCOPES = Object.freeze(Object.values(A2A_SCOPES));

/** Default scopes issued with a new credential. */
export const DEFAULT_A2A_SCOPES = Object.freeze([
  A2A_SCOPES.INVOKE,
  A2A_SCOPES.READ,
  A2A_SCOPES.CANCEL,
  A2A_SCOPES.ARTIFACT_READ,
]);

/**
 * @param {unknown} scopes
 * @returns {string[]}
 */
export function normalizeScopes(scopes) {
  if (scopes == null) return [...DEFAULT_A2A_SCOPES];
  if (!Array.isArray(scopes)) {
    throw new Error('scopes must be an array of strings');
  }
  const out = [];
  const seen = new Set();
  for (const s of scopes) {
    if (typeof s !== 'string' || !s.trim()) {
      throw new Error('each scope must be a non-empty string');
    }
    const v = s.trim();
    if (!ALL_A2A_SCOPES.includes(v)) {
      throw new Error(`unknown A2A scope: ${v}`);
    }
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  if (out.length === 0) {
    throw new Error('scopes must not be empty');
  }
  return out;
}

/**
 * @param {readonly string[] | null | undefined} granted
 * @param {string} required
 * @returns {boolean}
 */
export function hasScope(granted, required) {
  if (!Array.isArray(granted) || typeof required !== 'string') return false;
  return granted.includes(required);
}
