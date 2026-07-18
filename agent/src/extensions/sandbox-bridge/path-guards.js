/**
 * Logical path guards for sandbox-bridge (plan §13).
 * Never resolves to host filesystem; only logical sandbox paths.
 */

import {
  LOGICAL_SKILL_ROOT,
  LOGICAL_WORKSPACE_ROOT,
  MAX_PATH_LEN,
} from './constants.js';

/**
 * Normalize a model-supplied path to a logical sandbox path.
 * Relative paths → under workspace. Absolute must be under workspace or skill.
 *
 * @param {unknown} raw
 * @param {{ allowSkillRead?: boolean }} [opts]
 * @returns {{ ok: true, path: string, area: 'workspace' | 'skill' } | { ok: false, code: string, reason: string }}
 */
export function normalizeLogicalPath(raw, opts = {}) {
  if (raw == null || typeof raw !== 'string') {
    return { ok: false, code: 'PATH_INVALID', reason: 'path must be a string' };
  }
  let p = raw.trim();
  if (!p) {
    return { ok: false, code: 'PATH_INVALID', reason: 'path is empty' };
  }
  if (p.length > MAX_PATH_LEN) {
    return { ok: false, code: 'PATH_TOO_LONG', reason: 'path exceeds max length' };
  }
  // Reject null bytes and host-like prefixes
  if (p.includes('\0')) {
    return { ok: false, code: 'PATH_INVALID', reason: 'path contains null byte' };
  }
  if (/^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('//')) {
    return {
      ok: false,
      code: 'PATH_HOST_ESCAPE',
      reason: 'host-absolute or UNC paths are denied',
    };
  }

  // Collapse // and resolve . / .. within logical space only
  const isAbs = p.startsWith('/');
  const parts = p.split('/').filter((seg) => seg && seg !== '.');
  /** @type {string[]} */
  const stack = [];
  for (const seg of parts) {
    if (seg === '..') {
      if (stack.length === 0) {
        return {
          ok: false,
          code: 'PATH_TRAVERSAL',
          reason: 'path traversal denied',
        };
      }
      stack.pop();
      continue;
    }
    // Reject sneaky segments
    if (seg.includes('\\') || seg === '~') {
      return {
        ok: false,
        code: 'PATH_INVALID',
        reason: 'path segment denied',
      };
    }
    stack.push(seg);
  }

  let logical;
  if (isAbs) {
    logical = `/${stack.join('/')}`;
  } else {
    // Relative → workspace
    const wsParts = LOGICAL_WORKSPACE_ROOT.split('/').filter(Boolean);
    logical = `/${[...wsParts, ...stack].join('/')}`;
  }

  // Normalize workspace default when empty relative
  if (!isAbs && stack.length === 0) {
    logical = LOGICAL_WORKSPACE_ROOT;
  }

  if (logical === LOGICAL_SKILL_ROOT || logical.startsWith(`${LOGICAL_SKILL_ROOT}/`)) {
    if (!opts.allowSkillRead) {
      return {
        ok: false,
        code: 'PATH_SKILL_WRITE_DENIED',
        reason: 'skill path is read-only; writes denied',
      };
    }
    return { ok: true, path: logical, area: 'skill' };
  }

  if (
    logical === LOGICAL_WORKSPACE_ROOT ||
    logical.startsWith(`${LOGICAL_WORKSPACE_ROOT}/`)
  ) {
    return { ok: true, path: logical, area: 'workspace' };
  }

  return {
    ok: false,
    code: 'PATH_OUTSIDE_WORKSPACE',
    reason: 'path must be under workspace or skill root',
  };
}

/**
 * Write targets: workspace only, never skill.
 * @param {unknown} raw
 */
export function normalizeWritePath(raw) {
  const n = normalizeLogicalPath(raw, { allowSkillRead: false });
  if (!n.ok) {
    // Remap skill read-only to write denied when path looked like skill
    if (
      typeof raw === 'string' &&
      (raw.startsWith(LOGICAL_SKILL_ROOT) ||
        raw.includes('/skill/') ||
        raw.startsWith('skill/'))
    ) {
      return {
        ok: false,
        code: 'PATH_SKILL_WRITE_DENIED',
        reason: 'writes to skill directory are denied',
      };
    }
    return n;
  }
  if (n.area === 'skill') {
    return {
      ok: false,
      code: 'PATH_SKILL_WRITE_DENIED',
      reason: 'writes to skill directory are denied',
    };
  }
  return n;
}

/**
 * Detect host-escape patterns in bash/python commands (policy deny, not approval).
 * @param {string} command
 */
export function commandLooksLikeHostEscape(command) {
  if (typeof command !== 'string' || !command) return false;
  const c = command;
  // Absolute host-ish paths outside sandbox logical roots
  if (/(?:^|[\s;'"`])(?:\/etc\/|\/proc\/|\/sys\/|\/var\/|\/root\/|\/Users\/|\/home\/(?!sandbox\b))/m.test(c)) {
    // Allow /home/sandbox/*
    if (!/\/home\/sandbox\//.test(c) && /\/home\//.test(c)) return true;
    if (/\/(?:etc|proc|sys|var|root|Users)\//.test(c)) return true;
  }
  if (/\b(?:sudo|doas)\b/i.test(c)) return true;
  if (/\bcurl\b.*\b(?:file:\/\/|localhost|127\.0\.0\.1)\b/i.test(c)) return true;
  if (/(?:^|[\s;|&])(?:cat|less|more|head|tail)\s+\/etc\//i.test(c)) return true;
  if (/\b(?:docker|kubectl|ssh|nc|ncat|socat)\b/i.test(c)) return true;
  if (/\.\.\/|\.\.\\/.test(c) && /(?:etc|proc|sys|root)/.test(c)) return true;
  return false;
}
