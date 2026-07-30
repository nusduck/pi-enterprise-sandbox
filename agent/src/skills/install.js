/**
 * Atomic skill install from allowlisted local dirs or HTTPS Git.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  skillPackageDir,
  validateSkillName,
  writableSkillRoot,
} from './paths.js';
import {
  assertLocalSourceAllowlisted,
  validateGitHttpsUrl,
  validateGitRef,
  validateSkillPackage,
  validateSourceType,
} from './validator.js';
import { parseSkillMdFrontmatter } from './validator.js';

/** Explicit bounds keep large skill edits from hanging a tool turn or
 * flooding the event/ledger persistence path. */
export const SKILL_EDIT_MAX_BYTES = 16 * 1024 * 1024;
export const SKILL_EDIT_TIMEOUT_MS = 30_000;
export const SKILL_INSTALL_TIMEOUT_MS = 90_000;
export const SKILL_COMMAND_TIMEOUT_MS = 30_000;

/** Default git ref when the caller does not pin one. */
export const DEFAULT_GIT_REF = 'HEAD';

/** How deep subpath auto-discovery looks for a SKILL.md. */
const SUBPATH_SCAN_MAX_DEPTH = 3;
const SUBPATH_SCAN_MAX_CANDIDATES = 25;

/**
 * Infer the source type so callers can pass one `source` string instead of
 * having to say `sourceType: 'git'` alongside an obviously-git URL.
 *
 * @param {string} source
 * @returns {'git' | 'local'}
 */
export function detectSourceType(source) {
  const raw = String(source ?? '').trim();
  if (!raw) throw new Error('source is required');
  if (/^https?:\/\//i.test(raw)) return 'git';
  // git@, ssh://, git:// are rejected by the validator, but classify them as
  // git so the caller gets the real "HTTPS only" message instead of
  // "local source is not a directory".
  if (/^(?:git@|ssh:\/\/|git:\/\/)/i.test(raw)) return 'git';
  return 'local';
}

/**
 * Find the package directory inside a source tree.
 *
 * A repo may hold the SKILL.md at its root, or nest packages under
 * `skills/<name>/`. Rather than making the caller guess the subpath, search a
 * bounded depth: one candidate is used automatically, several are reported so
 * the caller can pick, none is an error naming what was searched.
 *
 * @param {string} root
 * @param {{ deadlineAt?: number }} [opts]
 * @returns {{ dir: string, subpath: string, candidates: string[] }}
 */
export function discoverSkillPackageDir(root, opts = {}) {
  const base = path.resolve(root);
  if (fs.existsSync(path.join(base, 'SKILL.md'))) {
    return { dir: base, subpath: '', candidates: [''] };
  }

  /** @type {string[]} */
  const candidates = [];
  /** @param {string} dir @param {number} depth */
  function walk(dir, depth) {
    if (depth > SUBPATH_SCAN_MAX_DEPTH) return;
    if (candidates.length >= SUBPATH_SCAN_MAX_CANDIDATES) return;
    assertBeforeDeadline(opts.deadlineAt);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
      const full = path.join(dir, ent.name);
      if (fs.existsSync(path.join(full, 'SKILL.md'))) {
        candidates.push(path.relative(base, full).replace(/\\/g, '/'));
        // A package's own subdirectories are not separate packages.
        continue;
      }
      walk(full, depth + 1);
    }
  }
  walk(base, 1);

  if (candidates.length === 1) {
    return {
      dir: path.join(base, candidates[0]),
      subpath: candidates[0],
      candidates,
    };
  }
  if (candidates.length === 0) {
    throw new Error(
      `No SKILL.md found at the source root or within ${SUBPATH_SCAN_MAX_DEPTH} levels. ` +
        'Point source at the package directory, or pass subpath.',
    );
  }
  throw new Error(
    `Source contains ${candidates.length} skill packages; pass subpath to choose one: ` +
      `${candidates.slice(0, 10).join(', ')}${candidates.length > 10 ? ', …' : ''}`,
  );
}

/**
 * Read the package's declared name from SKILL.md so the caller does not have
 * to repeat it (and cannot get it subtly wrong).
 *
 * @param {string} packageDir
 * @returns {string}
 */
export function readSkillPackageName(packageDir) {
  const skillMd = path.join(path.resolve(packageDir), 'SKILL.md');
  if (!fs.existsSync(skillMd)) {
    throw new Error('Missing SKILL.md in skill package');
  }
  return parseSkillMdFrontmatter(fs.readFileSync(skillMd, 'utf8')).name;
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number, deadlineAt?: number }} [opts]
 * @returns {Promise<{ stdout: string, stderr: string, code: number }>}
 */
function runCommand(command, args, opts = {}) {
  const requestedTimeout = opts.timeoutMs ?? SKILL_COMMAND_TIMEOUT_MS;
  const remaining = opts.deadlineAt == null ? requestedTimeout : opts.deadlineAt - Date.now();
  const timeoutMs = Math.min(requestedTimeout, remaining);
  if (timeoutMs <= 0) {
    return Promise.reject(new Error(`${command} timed out before it started`));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: {
        ...process.env,
        ...(opts.env || {}),
        // Avoid interactive prompts / credential helpers leaking
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle(reject, new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      stdout += d.toString();
      if (stdout.length > 2_000_000) stdout = stdout.slice(-1_000_000);
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 2_000_000) stderr = stderr.slice(-1_000_000);
    });
    child.on('error', (err) => {
      settle(reject, err);
    });
    child.on('close', (code) => {
      settle(resolve, { stdout, stderr, code: code ?? 1 });
    });
  });
}

function assertBeforeDeadline(deadlineAt) {
  if (deadlineAt != null && Date.now() >= deadlineAt) {
    throw new Error(`Skill operation timed out after ${SKILL_INSTALL_TIMEOUT_MS}ms`);
  }
}

/**
 * Recursive copy (files + dirs). Does not follow symlinks out of tree.
 * @param {string} src
 * @param {string} dest
 * @param {{ deadlineAt?: number }} [opts]
 */
async function copyTree(src, dest, opts = {}) {
  assertBeforeDeadline(opts.deadlineAt);
  const stat = await fsp.lstat(src);
  if (stat.isSymbolicLink()) {
    // Copy symlink as-is only if target stays reasonable; skip external links
    const link = await fsp.readlink(src);
    await fsp.symlink(link, dest);
    return;
  }
  if (stat.isDirectory()) {
    await fsp.mkdir(dest, { recursive: true });
    const entries = await fsp.readdir(src);
    for (const ent of entries) {
      if (ent === '.git') continue; // do not install VCS metadata into skill root
      await copyTree(path.join(src, ent), path.join(dest, ent), opts);
    }
    return;
  }
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const source = await fsp.open(src, 'r');
  const target = await fsp.open(dest, 'w');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    let position = 0;
    while (true) {
      assertBeforeDeadline(opts.deadlineAt);
      const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      let written = 0;
      while (written < bytesRead) {
        assertBeforeDeadline(opts.deadlineAt);
        const result = await target.write(
          buffer,
          written,
          bytesRead - written,
          position + written,
        );
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
  } finally {
    await Promise.allSettled([source.close(), target.close()]);
  }
}

/**
 * Remove path recursively if present.
 * @param {string} p
 */
async function rmrf(p) {
  try {
    await fsp.rm(p, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/**
 * Simple directory content digest for audit summary.
 * @param {string} dir
 * @param {{ deadlineAt?: number }} [opts]
 */
function digestDir(dir, opts = {}) {
  const hash = createHash('sha256');
  /** @param {string} d */
  function walk(d) {
    assertBeforeDeadline(opts.deadlineAt);
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
    } catch {
      return;
    }
    for (const ent of entries) {
      assertBeforeDeadline(opts.deadlineAt);
      if (ent.name === '.git') continue;
      const full = path.join(d, ent.name);
      const rel = path.relative(dir, full);
      if (ent.isDirectory()) {
        hash.update(`d:${rel}\n`);
        walk(full);
      } else if (ent.isFile()) {
        try {
          const st = fs.statSync(full);
          hash.update(`f:${rel}:${st.size}\n`);
          const fd = fs.openSync(full, 'r');
          const buffer = Buffer.allocUnsafe(64 * 1024);
          try {
            let offset = 0;
            let read;
            while ((read = fs.readSync(fd, buffer, 0, buffer.length, offset)) > 0) {
              hash.update(buffer.subarray(0, read));
              offset += read;
              assertBeforeDeadline(opts.deadlineAt);
            }
          } finally {
            fs.closeSync(fd);
          }
        } catch (err) {
          if (opts.deadlineAt != null && Date.now() >= opts.deadlineAt) throw err;
          hash.update(`f:${rel}\n`);
        }
      }
    }
  }
  walk(dir);
  return hash.digest('hex').slice(0, 16);
}

/**
 * Atomically replace dest with contents prepared in stagingDir.
 * On failure, restores previous dest if it existed and cleans staging.
 *
 * @param {string} stagingDir - fully prepared skill package dir
 * @param {string} destDir - final package path (skillRoot/name)
 */
export async function atomicReplaceDir(stagingDir, destDir) {
  const parent = path.dirname(destDir);
  await fsp.mkdir(parent, { recursive: true });

  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const backupDir = path.join(parent, `.backup-${path.basename(destDir)}-${token}`);
  let movedExisting = false;
  let swapped = false;

  try {
    // Ensure staging is on same filesystem parent when possible
    if (!fs.existsSync(stagingDir)) {
      throw new Error('Staging directory missing before atomic replace');
    }

    if (fs.existsSync(destDir)) {
      await fsp.rename(destDir, backupDir);
      movedExisting = true;
    }

    await fsp.rename(stagingDir, destDir);
    swapped = true;

    if (movedExisting) {
      await rmrf(backupDir);
    }
  } catch (err) {
    // Rollback
    if (swapped) {
      // rename to dest succeeded but later step failed — rare
      await rmrf(destDir);
    }
    if (movedExisting && fs.existsSync(backupDir)) {
      try {
        if (fs.existsSync(destDir)) await rmrf(destDir);
        await fsp.rename(backupDir, destDir);
      } catch (restoreErr) {
        throw new Error(
          `Atomic replace failed and restore failed: ${err.message}; restore: ${restoreErr.message}`,
        );
      }
    }
    await rmrf(stagingDir);
    await rmrf(backupDir);
    throw err;
  }
}

/**
 * Clone HTTPS git repo at ref into targetDir; return resolved commit.
 * @param {string} url
 * @param {string} ref
 * @param {string} targetDir
 * @param {{ deadlineAt?: number }} [opts]
 */
async function gitCloneAtRef(url, ref, targetDir, opts = {}) {
  const commandOpts = () => {
    assertBeforeDeadline(opts.deadlineAt);
    const remaining = opts.deadlineAt == null
      ? SKILL_COMMAND_TIMEOUT_MS
      : Math.max(1, opts.deadlineAt - Date.now());
    return {
      timeoutMs: Math.min(SKILL_COMMAND_TIMEOUT_MS, remaining),
      deadlineAt: opts.deadlineAt,
    };
  };
  await rmrf(targetDir);
  await fsp.mkdir(path.dirname(targetDir), { recursive: true });

  // Initialize an empty repository and fetch exactly the requested ref. This
  // avoids downloading the default HEAD and then downloading the requested
  // branch/tag a second time.
  const init = await runCommand('git', ['init', '--quiet', targetDir], commandOpts());
  if (init.code !== 0) {
    throw new Error(`git init failed: ${(init.stderr || init.stdout).slice(0, 400)}`);
  }
  const remote = await runCommand(
    'git',
    ['remote', 'add', 'origin', url],
    { cwd: targetDir, ...commandOpts() },
  );
  if (remote.code !== 0) {
    throw new Error(`git remote setup failed: ${(remote.stderr || remote.stdout).slice(0, 400)}`);
  }
  const fetch = await runCommand(
    'git',
    ['fetch', '--depth', '1', '--filter=blob:none', 'origin', ref],
    { cwd: targetDir, ...commandOpts() },
  );
  if (fetch.code !== 0) {
    throw new Error(
      `git ref fetch failed for "${ref}": ${(fetch.stderr || fetch.stdout).slice(0, 400)}. ` +
      'The Git server must support filtered HTTPS fetches; use a compatible mirror or ref.',
    );
  }

  const checkout = await runCommand(
    'git',
    ['checkout', '--force', 'FETCH_HEAD'],
    { cwd: targetDir, ...commandOpts() },
  );
  if (checkout.code !== 0) {
    throw new Error(
      `git checkout failed for ref "${ref}": ${(checkout.stderr || checkout.stdout).slice(0, 400)}`,
    );
  }

  const rev = await runCommand('git', ['rev-parse', 'HEAD'], {
    cwd: targetDir,
    ...commandOpts(),
  });
  if (rev.code !== 0) {
    throw new Error('Failed to resolve git commit after checkout');
  }
  return rev.stdout.trim();
}

/**
 * Install a skill package into the writable (user) skill root.
 *
 * `sourceType`, `name`, `ref` and `subpath` are all optional: the source type
 * is inferred from the source string, the package directory is discovered
 * inside the fetched tree, and the name comes from the package's own SKILL.md.
 * Supplying any of them pins it and turns a mismatch into an error.
 *
 * @param {{
 *   name?: string,
 *   sourceType?: string,
 *   source: string,
 *   ref?: string,
 *   skillRoot: string,
 *   localAllowlist?: string[],
 *   subpath?: string,
 *   timeoutMs?: number,
 *   systemSkillNames?: Iterable<string>,
 * }} opts
 */
export async function installSkill(opts) {
  const sourceType = opts.sourceType
    ? validateSourceType(opts.sourceType)
    : detectSourceType(opts.source);
  const requestedName = opts.name ? validateSkillName(opts.name) : null;
  const skillRoot = path.resolve(opts.skillRoot || writableSkillRoot() || '');
  if (!skillRoot || skillRoot === path.resolve('')) {
    throw new Error(
      'No writable skill root is configured; installs require a user skill root',
    );
  }
  const installTimeoutMs = Number.isFinite(opts.timeoutMs)
    ? Math.max(1, Number(opts.timeoutMs))
    : SKILL_INSTALL_TIMEOUT_MS;
  const deadlineAt = Date.now() + installTimeoutMs;

  // Staging inside the skill root so the final rename stays on one filesystem.
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const stagingRoot = path.join(skillRoot, `.tmp-install-${token}`);
  const stagingPkg = path.join(stagingRoot, '_pkg');

  let resolvedCommit = null;
  let sourceSummary = opts.source;
  const ref = sourceType === 'git' ? validateGitRef(opts.ref || DEFAULT_GIT_REF) : null;

  /** @param {string} sub */
  const assertSubpath = (sub) => {
    if (sub.includes('..') || path.isAbsolute(sub)) {
      throw new Error('Invalid subpath');
    }
    return sub;
  };

  try {
    await fsp.mkdir(stagingRoot, { recursive: true });

    /** Tree the package is copied out of, plus the subpath actually used. */
    let sourceTree;
    if (sourceType === 'local') {
      const allowed = assertLocalSourceAllowlisted(
        opts.source,
        opts.localAllowlist || [],
      );
      if (!fs.existsSync(allowed) || !fs.statSync(allowed).isDirectory()) {
        throw new Error('Local source is not a directory');
      }
      sourceTree = allowed;
      sourceSummary = allowed;
    } else {
      const url = validateGitHttpsUrl(opts.source);
      const cloneDir = path.join(stagingRoot, '_clone');
      resolvedCommit = await gitCloneAtRef(url, ref, cloneDir, { deadlineAt });
      sourceTree = cloneDir;
      sourceSummary = url;
    }

    const explicitSub = opts.subpath
      ? assertSubpath(String(opts.subpath).replace(/^\/+/, ''))
      : '';
    let packageSrc;
    let usedSubpath;
    if (explicitSub) {
      packageSrc = path.join(sourceTree, explicitSub);
      if (!fs.existsSync(packageSrc)) {
        throw new Error(`Subpath not found in source: ${explicitSub}`);
      }
      usedSubpath = explicitSub;
    } else {
      const discovered = discoverSkillPackageDir(sourceTree, { deadlineAt });
      packageSrc = discovered.dir;
      usedSubpath = discovered.subpath;
    }
    assertBeforeDeadline(deadlineAt);

    // The package's own SKILL.md is authoritative for the name; an explicit
    // name is a pin that must agree with it.
    const declaredName = readSkillPackageName(packageSrc);
    const name = requestedName ?? declaredName;
    if (requestedName && requestedName !== declaredName) {
      throw new Error(
        `SKILL.md name "${declaredName}" does not match requested name "${requestedName}"`,
      );
    }

    // A user package must not shadow a bundled system package: discovery reads
    // the system root first, so the install would silently have no effect.
    const systemNames = new Set(
      opts.systemSkillNames ? [...opts.systemSkillNames].map(String) : [],
    );
    if (systemNames.has(name)) {
      throw new Error(
        `"${name}" is a bundled system skill and cannot be replaced by an install. ` +
          'Choose a different name in SKILL.md.',
      );
    }

    const dest = skillPackageDir(skillRoot, name);
    await copyTree(packageSrc, stagingPkg, { deadlineAt });
    await rmrf(path.join(stagingPkg, '.git'));

    const meta = validateSkillPackage(stagingPkg, { expectedName: name });
    const digest = digestDir(stagingPkg, { deadlineAt });
    assertBeforeDeadline(deadlineAt);

    // Reinstalling identical content is an explicit no-op rather than a
    // replace, so repeated installs do not churn the skill tree.
    if (fs.existsSync(dest)) {
      try {
        const existingMeta = validateSkillPackage(dest, { expectedName: name });
        const existingDigest = digestDir(dest, { deadlineAt });
        if (existingDigest === digest) {
          await rmrf(stagingRoot);
          return {
            name: existingMeta.name,
            description: existingMeta.description,
            path: dest,
            source_type: sourceType,
            source: sourceSummary,
            ref,
            subpath: usedSubpath || null,
            resolved_commit: resolvedCommit,
            digest: existingDigest,
            idempotent: true,
            summary: `already installed ${existingMeta.name} digest=${existingDigest}`,
          };
        }
      } catch {
        // Invalid or changed destinations are replaced atomically below.
      }
    }

    assertBeforeDeadline(deadlineAt);
    await atomicReplaceDir(stagingPkg, dest);
    await rmrf(stagingRoot);

    return {
      name: meta.name,
      description: meta.description,
      path: dest,
      source_type: sourceType,
      source: sourceSummary,
      ref,
      subpath: usedSubpath || null,
      resolved_commit: resolvedCommit,
      digest,
      summary: `installed ${meta.name} digest=${digest}` +
        (resolvedCommit ? ` commit=${resolvedCommit.slice(0, 12)}` : ''),
    };
  } catch (err) {
    await rmrf(stagingRoot);
    // Do not leave partial dest from failed rename — atomicReplaceDir handles dest
    throw err;
  }
}

/**
 * Remove an installed package from the writable skill root.
 *
 * @param {{ name: string, skillRoot: string }} opts
 */
export async function uninstallSkill(opts) {
  const name = validateSkillName(opts.name);
  const skillRoot = path.resolve(opts.skillRoot || writableSkillRoot() || '');
  const dest = skillPackageDir(skillRoot, name);
  if (!fs.existsSync(dest)) {
    throw new Error(
      `"${name}" is not installed in the user skill root (bundled system skills cannot be uninstalled)`,
    );
  }
  await rmrf(dest);
  return { name, path: dest, summary: `uninstalled ${name}` };
}

/**
 * Write or replace a single file under the skill root (development edit).
 * @param {{
 *   skillRoot: string,
 *   path: string,
 *   content: string,
 *   timeoutMs?: number,
 *   maxBytes?: number,
 * }} opts
 */
export async function editSkillFile(opts) {
  const { resolveSkillPath } = await import('./paths.js');
  const { absolute, relative } = resolveSkillPath(opts.path, opts.skillRoot);
  const content = typeof opts.content === 'string' ? opts.content : String(opts.content ?? '');
  const maxBytes = Number.isFinite(opts.maxBytes)
    ? Math.max(1, Number(opts.maxBytes))
    : SKILL_EDIT_MAX_BYTES;
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > maxBytes) {
    throw new Error(
      `skill_edit content is ${bytes} bytes; maximum is ${maxBytes} bytes. ` +
      'Split the edit into smaller files or use an allowlisted install.',
    );
  }

  // If editing SKILL.md, validate content before write
  if (path.basename(absolute) === 'SKILL.md') {
    const { parseSkillMdFrontmatter } = await import('./validator.js');
    parseSkillMdFrontmatter(content);
  }

  await fsp.mkdir(path.dirname(absolute), { recursive: true });

  // Atomic write via temp file in same directory
  const tmp = `${absolute}.tmp-${process.pid}-${Date.now()}`;
  const timeoutMs = Number.isFinite(opts.timeoutMs)
    ? Math.max(1, Number(opts.timeoutMs))
    : SKILL_EDIT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fsp.writeFile(tmp, content, { encoding: 'utf8', signal: controller.signal });
    if (controller.signal.aborted) {
      throw new Error(`skill_edit timed out after ${timeoutMs}ms while writing ${relative}`);
    }
    await fsp.rename(tmp, absolute);
  } catch (err) {
    await rmrf(tmp);
    if (controller.signal.aborted || err?.name === 'AbortError') {
      throw new Error(`skill_edit timed out after ${timeoutMs}ms while writing ${relative}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  return {
    path: relative,
    absolute,
    bytes,
  };
}

/**
 * List installed skill package names under root.
 * @param {string} skillRoot
 */
export function listInstalledSkills(skillRoot) {
  const root = path.resolve(skillRoot);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .filter((n) => {
      try {
        validateSkillName(n);
        return fs.existsSync(path.join(root, n, 'SKILL.md'));
      } catch {
        return false;
      }
    });
}

/**
 * Describe the installed packages across every root, tagging which tier each
 * came from. System packages shadow user packages of the same name because
 * discovery reads the roots in order.
 *
 * @param {string[]} skillRoots - in read-precedence order (system first)
 * @param {{ writableRoot?: string | null }} [opts]
 * @returns {Array<{
 *   name: string,
 *   description: string | null,
 *   tier: 'system' | 'user',
 *   root: string,
 *   path: string,
 *   editable: boolean,
 *   invalid?: string,
 * }>}
 */
export function describeInstalledSkills(skillRoots, opts = {}) {
  const writable = opts.writableRoot ? path.resolve(opts.writableRoot) : null;
  /** @type {Map<string, object>} */
  const byName = new Map();
  for (const rawRoot of skillRoots || []) {
    const root = path.resolve(String(rawRoot));
    const tier = writable && root === writable ? 'user' : 'system';
    for (const name of listInstalledSkills(root)) {
      // First root wins: a later root cannot shadow an earlier one.
      if (byName.has(name)) continue;
      const dir = path.join(root, name);
      let description = null;
      let invalid;
      try {
        description = validateSkillPackage(dir, { expectedName: name }).description;
      } catch (err) {
        invalid = err instanceof Error ? err.message : String(err);
      }
      byName.set(name, {
        name,
        description,
        tier,
        root,
        path: dir,
        editable: tier === 'user',
        ...(invalid ? { invalid } : {}),
      });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** @deprecated test helper */
export function _testHelpers() {
  return { copyTree, rmrf, digestDir, runCommand, gitCloneAtRef };
}
