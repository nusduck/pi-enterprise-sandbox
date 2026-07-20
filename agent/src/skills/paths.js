/**
 * Skill path policy — resolve roots, detect skill-tree paths, prevent escape.
 */
import path from 'node:path';
import fs from 'node:fs';

/** Canonical agent-visible skill root (logical read-only mount). */
export const DEFAULT_SKILL_ROOTS = Object.freeze(['/home/sandbox/skill']);

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
 * Primary (first) skill root used for installs.
 * @param {string[]} roots
 */
export function primarySkillRoot(roots = DEFAULT_SKILL_ROOTS) {
  return normalizeSkillRoots(roots)[0];
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
