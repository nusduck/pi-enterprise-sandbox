/**
 * Skill path policy — resolve roots, detect skill-tree paths, prevent escape.
 */
import path from 'node:path';
import fs from 'node:fs';

/**
 * Skills come in two tiers, on two separate logical mounts:
 *
 *   SYSTEM_SKILL_ROOT  bundled first-party packages shipped in the image
 *                      (repo `skills/`). Always read-only, in every mode —
 *                      an installed skill must never be able to shadow or
 *                      overwrite one the platform vouches for.
 *   USER_SKILL_ROOT    base of the per-user tier. Nothing is installed at the
 *                      base itself; each user gets `<base>/<orgId>/<userId>`.
 *
 * The per-user layout is what makes installs safe to allow without a
 * deployment-wide mode flag: this is a multi-tenant server, so one user's
 * install must never enter another user's (or another org's) agent context.
 *
 * A Run reads the union of the system tier and its own user directory, system
 * first. Installs and edits only ever target that one user directory.
 */
export const SYSTEM_SKILL_ROOT = '/home/sandbox/skill';
export const USER_SKILL_ROOT = '/home/sandbox/skill-user';

/**
 * Canonical *mount* roots, system first. These are the volumes; the per-user
 * directory beneath USER_SKILL_ROOT is resolved per Run.
 */
export const DEFAULT_SKILL_ROOTS = Object.freeze([
  SYSTEM_SKILL_ROOT,
  USER_SKILL_ROOT,
]);

/** Identity segment: ULID-shaped ids only, so no segment can traverse. */
const IDENTITY_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
function assertIdentitySegment(value, field) {
  const segment = String(value ?? '').trim();
  if (!IDENTITY_SEGMENT_RE.test(segment)) {
    throw new Error(
      `Invalid ${field} for skill path: must match /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/`,
    );
  }
  return segment;
}

/**
 * The one directory a given user's installs live in.
 *
 * Org is included so the path is unique even if user ids were ever reissued
 * per org, and so an operator can wipe a whole tenant's skills as one subtree.
 *
 * @param {{ orgId: unknown, userId: unknown }} identity
 * @param {string} [base]
 * @returns {string}
 */
export function userSkillRootFor(identity, base = USER_SKILL_ROOT) {
  const orgId = assertIdentitySegment(identity?.orgId, 'orgId');
  const userId = assertIdentitySegment(identity?.userId, 'userId');
  return path.join(path.resolve(base), orgId, userId);
}

/**
 * Skill roots one Run may read, in precedence order.
 * Without an identity there is no user tier — the caller sees system only.
 *
 * @param {{ orgId?: unknown, userId?: unknown } | null | undefined} identity
 * @param {{ systemRoot?: string, userRootBase?: string }} [opts]
 * @returns {string[]}
 */
export function skillRootsForIdentity(identity, opts = {}) {
  const systemRoot = opts.systemRoot || SYSTEM_SKILL_ROOT;
  if (identity?.orgId == null || identity?.userId == null) {
    return normalizeSkillRoots([systemRoot]);
  }
  return normalizeSkillRoots([
    systemRoot,
    userSkillRootFor(
      { orgId: identity.orgId, userId: identity.userId },
      opts.userRootBase || USER_SKILL_ROOT,
    ),
  ]);
}

/** Valid skill directory / package name. */
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * @param {string | null | undefined} name
 * @returns {string}
 */
export function validateSkillName(name) {
  const n = String(name || '').trim();
  if (!SKILL_NAME_RE.test(n)) {
    throw new Error(
      'Invalid skill name: must match /^[a-z0-9][a-z0-9_-]{0,63}$/ (lowercase slug)',
    );
  }
  if (n === '.' || n === '..' || n.includes('/') || n.includes('\\')) {
    throw new Error('Invalid skill name: path separators not allowed');
  }
  return n;
}

/**
 * Normalize a list of skill roots to absolute resolved paths where possible.
 * @param {string[]} roots
 * @returns {string[]}
 */
export function normalizeSkillRoots(roots = DEFAULT_SKILL_ROOTS) {
  const out = [];
  const seen = new Set();
  for (const r of roots || []) {
    if (!r || typeof r !== 'string') continue;
    const trimmed = r.trim();
    if (!trimmed) continue;
    try {
      const resolved = path.resolve(trimmed);
      if (!seen.has(resolved)) {
        seen.add(resolved);
        out.push(resolved);
      }
    } catch {
      if (!seen.has(trimmed)) {
        seen.add(trimmed);
        out.push(trimmed);
      }
    }
  }
  return out.length ? out : [...DEFAULT_SKILL_ROOTS];
}

/**
 * Primary (first) skill root — read precedence, and the root whose logical
 * path appears in prompts and redaction.
 * @param {string[]} roots
 */
export function primarySkillRoot(roots = DEFAULT_SKILL_ROOTS) {
  return normalizeSkillRoots(roots)[0];
}

/**
 * The one root installs and edits may write to.
 *
 * Never the system root (bundled packages are part of the image), and never
 * the user *base* — the base only holds per-user directories, so a package
 * written there would belong to nobody. Returns null when neither applies, so
 * the caller refuses the write instead of falling back to a read-only mount.
 *
 * @param {string[]} roots
 */
export function writableSkillRoot(roots = DEFAULT_SKILL_ROOTS) {
  const normalized = normalizeSkillRoots(roots);
  const systemResolved = path.resolve(SYSTEM_SKILL_ROOT);
  const userBaseResolved = path.resolve(USER_SKILL_ROOT);

  const writable = normalized.filter(
    (r) => r !== systemResolved && r !== userBaseResolved,
  );
  return writable.length > 0 ? writable[writable.length - 1] : null;
}

/**
 * True if `userPath` is under any skill root (logical prefix or resolved realpath).
 * @param {string | null | undefined} userPath
 * @param {string[]} [skillRoots]
 */
export function isUnderSkillRoot(userPath, skillRoots = DEFAULT_SKILL_ROOTS) {
  if (userPath == null || typeof userPath !== 'string') return false;
  const raw = userPath.trim();
  if (!raw || raw.includes('\0')) return false;

  const roots = normalizeSkillRoots(skillRoots);
  const candidates = [raw];
  // Also try as absolute resolve of relative paths
  if (!path.isAbsolute(raw)) {
    candidates.push(path.resolve(raw));
  } else {
    candidates.push(path.resolve(raw));
  }

  for (const candidate of candidates) {
    const normalized = candidate.replace(/\\/g, '/');
    for (const root of roots) {
      const rootNorm = root.replace(/\\/g, '/').replace(/\/+$/, '');
      if (
        normalized === rootNorm ||
        normalized.startsWith(`${rootNorm}/`) ||
        // Relative forms used in prompts / tools
        normalized === rootNorm.slice(1) ||
        normalized.startsWith(`${rootNorm.slice(1)}/`)
      ) {
        return true;
      }
      // Realpath check when paths exist
      try {
        if (fs.existsSync(candidate) && fs.existsSync(root)) {
          const realC = fs.realpathSync(candidate);
          const realR = fs.realpathSync(root);
          if (realC === realR || realC.startsWith(realR + path.sep)) {
            return true;
          }
        }
      } catch {
        /* ignore */
      }
    }
  }
  return false;
}

/**
 * True if a shell command string references a skill root (write bypass risk).
 * @param {string | null | undefined} command
 * @param {string[]} [skillRoots]
 */
export function commandTouchesSkillRoot(command, skillRoots = DEFAULT_SKILL_ROOTS) {
  if (!command || typeof command !== 'string') return false;
  const cmd = command;
  const roots = normalizeSkillRoots(skillRoots);
  for (const root of roots) {
    const rootNorm = root.replace(/\\/g, '/');
    if (cmd.includes(rootNorm) || cmd.includes(rootNorm.slice(1))) {
      return true;
    }
  }
  return false;
}

/**
 * True only for a simple, read-only execution of a script stored under a skill
 * root. Shell operators are deliberately rejected so the script path cannot be
 * combined with a write or a second command.
 *
 * @param {string | null | undefined} command
 * @param {string[]} [skillRoots]
 */
export function isReadonlySkillExecution(command, skillRoots = DEFAULT_SKILL_ROOTS) {
  if (!command || typeof command !== 'string') return false;
  if (/[;&|<>`\n\r$*?{}\[\]!]/.test(command) || command.includes('$(')) return false;

  const match = command.match(
    /^\s*(python3?|\/usr\/bin\/python3?|bash|sh)\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))(?:\s+.*)?\s*$/,
  );
  if (!match) return false;

  const interpreter = match[1];
  const scriptPath = match[2] || match[3] || match[4] || '';
  if (!isUnderSkillRoot(scriptPath, skillRoots)) return false;
  // A package's executable assets live under scripts/.  Do not treat an
  // arbitrary .py/.sh file beside SKILL.md as an entrypoint.
  if (!/\/scripts\/[^/]+$/.test(scriptPath.replace(/\\/g, '/'))) return false;
  if (interpreter === 'bash' || interpreter === 'sh') return scriptPath.endsWith('.sh');
  return scriptPath.endsWith('.py');
}

/**
 * Resolve a skill-relative path strictly under the primary skill root.
 * Rejects escape via `..`, absolute paths outside root, and null bytes.
 *
 * @param {string} userPath - relative to skill root or absolute under a skill root
 * @param {string} skillRoot
 * @returns {{ absolute: string, relative: string }}
 */
export function resolveSkillPath(userPath, skillRoot) {
  if (userPath == null || typeof userPath !== 'string') {
    throw new Error('Invalid path');
  }
  if (userPath.includes('\0')) {
    throw new Error('Invalid path: null byte');
  }
  const raw = userPath.trim();
  if (!raw || raw === '.' || raw.startsWith('~')) {
    throw new Error('Invalid skill path');
  }

  const rootResolved = path.resolve(skillRoot);
  let relative = raw;

  // Strip known skill-root prefixes to a relative path
  const roots = normalizeSkillRoots([skillRoot, ...DEFAULT_SKILL_ROOTS]);
  for (const r of roots) {
    const rn = r.replace(/\\/g, '/').replace(/\/+$/, '');
    const rawN = raw.replace(/\\/g, '/');
    if (rawN === rn) {
      throw new Error('Invalid skill path: must target a file under a skill package');
    }
    if (rawN.startsWith(`${rn}/`)) {
      relative = rawN.slice(rn.length + 1);
      break;
    }
  }

  if (path.isAbsolute(relative) && relative === raw) {
    // Absolute path that did not match any skill root
    throw new Error('Path escape detected: absolute path outside skill root');
  }

  // Reject Windows-style drive paths
  if (/^[A-Za-z]:/.test(relative)) {
    throw new Error('Path escape detected: absolute path outside skill root');
  }

  const joined = path.resolve(rootResolved, relative);
  const relToRoot = path.relative(rootResolved, joined);
  if (
    relToRoot.startsWith('..') ||
    path.isAbsolute(relToRoot) ||
    relToRoot === ''
  ) {
    throw new Error('Path escape detected: path leaves skill root');
  }

  // Optional realpath check if parent exists
  try {
    const parent = path.dirname(joined);
    if (fs.existsSync(parent)) {
      const realParent = fs.realpathSync(parent);
      const realRoot = fs.existsSync(rootResolved)
        ? fs.realpathSync(rootResolved)
        : rootResolved;
      if (realParent !== realRoot && !realParent.startsWith(realRoot + path.sep)) {
        throw new Error('Path escape detected: resolved path leaves skill root');
      }
    }
  } catch (err) {
    if (String(err.message || '').includes('Path escape')) throw err;
  }

  return { absolute: joined, relative: relToRoot.replace(/\\/g, '/') };
}

/**
 * Destination directory for a named skill package.
 * @param {string} skillRoot
 * @param {string} name
 */
export function skillPackageDir(skillRoot, name) {
  const safe = validateSkillName(name);
  return path.join(path.resolve(skillRoot), safe);
}
