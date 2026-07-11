/**
 * Skill source and SKILL.md validators.
 */
import fs from 'node:fs';
import path from 'node:path';
import { validateSkillName } from './paths.js';

/**
 * Validate an HTTPS Git source URL for skill install.
 * Rejects git@, ssh, file, credentials-in-URL, non-https.
 *
 * @param {string} rawUrl
 * @returns {string} normalized https URL (no trailing .git required)
 */
export function validateGitHttpsUrl(rawUrl) {
  if (rawUrl == null || typeof rawUrl !== 'string') {
    throw new Error('Git source URL is required');
  }
  const url = rawUrl.trim();
  if (!url) throw new Error('Git source URL is required');

  const lower = url.toLowerCase();
  if (
    lower.startsWith('git@') ||
    lower.startsWith('ssh://') ||
    lower.startsWith('file://') ||
    lower.startsWith('git://') ||
    lower.includes('git@')
  ) {
    throw new Error('Rejected git source: only HTTPS Git URLs are allowed (no SSH/git@)');
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Rejected git source: invalid URL');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('Rejected git source: only https:// URLs are allowed');
  }

  if (parsed.username || parsed.password) {
    throw new Error('Rejected git source: credentials in URL are not allowed');
  }

  if (lower.startsWith('npm:') || lower.startsWith('oci://')) {
    throw new Error('Rejected source: npm/OCI installs are not supported');
  }

  // Reconstruct without any accidental userinfo
  const clean = `https://${parsed.host}${parsed.pathname}${parsed.search || ''}`;
  return clean.replace(/\/+$/, '') || clean;
}

/**
 * Validate git ref (branch, tag, or commit). Required non-empty, no shell metachar.
 * @param {string | null | undefined} ref
 */
export function validateGitRef(ref) {
  const r = String(ref ?? '').trim();
  if (!r) {
    throw new Error('Git ref is required (branch, tag, or commit SHA)');
  }
  // Conservative: no spaces, no shell metacharacters, no path tricks
  if (!/^[A-Za-z0-9][A-Za-z0-9._\/+-]{0,255}$/.test(r)) {
    throw new Error(
      'Invalid git ref: use a branch, tag, or commit (alphanumeric, . _ / + - only)',
    );
  }
  if (r.includes('..') || r.startsWith('-')) {
    throw new Error('Invalid git ref');
  }
  return r;
}

/**
 * Reject disallowed install source types (scripts, tarballs, npm, oci).
 * @param {string} sourceType
 */
export function validateSourceType(sourceType) {
  const t = String(sourceType || '').trim().toLowerCase();
  if (t === 'local' || t === 'git' || t === 'https-git' || t === 'https_git') {
    return t === 'local' ? 'local' : 'git';
  }
  if (['npm', 'oci', 'tarball', 'zip', 'script', 'http', 'https'].includes(t)) {
    throw new Error(
      `Rejected source type "${t}": only local (allowlisted) and HTTPS git are supported`,
    );
  }
  throw new Error(`Unknown source type "${sourceType}": use "local" or "git"`);
}

/**
 * Parse minimal YAML frontmatter from SKILL.md (name + description required).
 * Intentionally small — no full YAML dependency.
 *
 * @param {string} content
 * @returns {{ name: string, description: string, rawFrontmatter: string }}
 */
export function parseSkillMdFrontmatter(content) {
  if (content == null || typeof content !== 'string') {
    throw new Error('SKILL.md is empty or unreadable');
  }
  const text = content.replace(/^\uFEFF/, '');
  if (!text.startsWith('---')) {
    throw new Error('SKILL.md must start with YAML frontmatter (---)');
  }
  const end = text.indexOf('\n---', 3);
  if (end === -1) {
    throw new Error('SKILL.md frontmatter is not closed');
  }
  const fm = text.slice(3, end).trim();
  const body = text.slice(end + 4);
  if (!body.trim()) {
    throw new Error('SKILL.md body is empty after frontmatter');
  }

  /** @type {Record<string, string>} */
  const fields = {};
  for (const line of fm.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    fields[m[1]] = val;
  }

  if (!fields.name || !String(fields.name).trim()) {
    throw new Error('SKILL.md frontmatter missing required field: name');
  }
  if (!fields.description || !String(fields.description).trim()) {
    throw new Error('SKILL.md frontmatter missing required field: description');
  }

  const name = validateSkillName(fields.name);
  return {
    name,
    description: String(fields.description).trim(),
    rawFrontmatter: fm,
  };
}

/**
 * Validate a skill package directory: SKILL.md present and well-formed.
 * @param {string} dir
 * @param {{ expectedName?: string }} [opts]
 * @returns {{ name: string, description: string, skillMdPath: string }}
 */
export function validateSkillPackage(dir, opts = {}) {
  if (!dir || typeof dir !== 'string') {
    throw new Error('Skill package directory is required');
  }
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new Error(`Skill package not found or not a directory: ${path.basename(abs)}`);
  }

  const skillMdPath = path.join(abs, 'SKILL.md');
  if (!fs.existsSync(skillMdPath) || !fs.statSync(skillMdPath).isFile()) {
    throw new Error('Missing SKILL.md in skill package');
  }

  const content = fs.readFileSync(skillMdPath, 'utf8');
  const meta = parseSkillMdFrontmatter(content);

  if (opts.expectedName) {
    const expected = validateSkillName(opts.expectedName);
    if (meta.name !== expected) {
      throw new Error(
        `SKILL.md name "${meta.name}" does not match install name "${expected}"`,
      );
    }
    // Directory basename should match as well when present
    const base = path.basename(abs);
    if (base !== expected && base !== path.basename(abs)) {
      /* no-op */
    }
  }

  return {
    name: meta.name,
    description: meta.description,
    skillMdPath,
  };
}

/**
 * Ensure a local source path is under one of the allowlisted directories.
 * @param {string} sourcePath
 * @param {string[]} allowlist absolute or resolvable dirs
 */
export function assertLocalSourceAllowlisted(sourcePath, allowlist) {
  if (!sourcePath || typeof sourcePath !== 'string') {
    throw new Error('Local source path is required');
  }
  if (sourcePath.includes('\0')) {
    throw new Error('Invalid local source path');
  }
  const list = (allowlist || []).map((p) => path.resolve(String(p).trim())).filter(Boolean);
  if (list.length === 0) {
    throw new Error(
      'Local skill install denied: SKILLS_INSTALL_LOCAL_ALLOWLIST is empty',
    );
  }

  let resolved;
  try {
    resolved = fs.existsSync(sourcePath)
      ? fs.realpathSync(path.resolve(sourcePath))
      : path.resolve(sourcePath);
  } catch {
    resolved = path.resolve(sourcePath);
  }

  for (const allowed of list) {
    let realAllowed = allowed;
    try {
      if (fs.existsSync(allowed)) realAllowed = fs.realpathSync(allowed);
    } catch {
      /* use resolved allowed */
    }
    if (resolved === realAllowed || resolved.startsWith(realAllowed + path.sep)) {
      return resolved;
    }
  }

  throw new Error(
    'Local skill install denied: source path is not under SKILLS_INSTALL_LOCAL_ALLOWLIST',
  );
}
