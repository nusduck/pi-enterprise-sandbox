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
  primarySkillRoot,
} from './paths.js';
import {
  assertLocalSourceAllowlisted,
  validateGitHttpsUrl,
  validateGitRef,
  validateSkillPackage,
  validateSourceType,
} from './validator.js';

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number }} [opts]
 * @returns {Promise<{ stdout: string, stderr: string, code: number }>}
 */
function runCommand(command, args, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 120_000;
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
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
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
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}

/**
 * Recursive copy (files + dirs). Does not follow symlinks out of tree.
 * @param {string} src
 * @param {string} dest
 */
async function copyTree(src, dest) {
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
      await copyTree(path.join(src, ent), path.join(dest, ent));
    }
    return;
  }
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.copyFile(src, dest);
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
 */
function digestDir(dir) {
  const hash = createHash('sha256');
  /** @param {string} d */
  function walk(d) {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
    } catch {
      return;
    }
    for (const ent of entries) {
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
        } catch {
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
 */
async function gitCloneAtRef(url, ref, targetDir) {
  await rmrf(targetDir);
  await fsp.mkdir(path.dirname(targetDir), { recursive: true });

  // Shallow clone then fetch/checkout ref (works for branch/tag; commit may need deepen)
  const clone = await runCommand('git', [
    'clone',
    '--no-checkout',
    '--filter=blob:none',
    url,
    targetDir,
  ]);
  if (clone.code !== 0) {
    // Fallback without filter for older git
    await rmrf(targetDir);
    const clone2 = await runCommand('git', ['clone', '--no-checkout', url, targetDir]);
    if (clone2.code !== 0) {
      throw new Error(
        `git clone failed: ${(clone2.stderr || clone.stderr || clone2.stdout).slice(0, 400)}`,
      );
    }
  }

  // Fetch the specific ref
  let fetch = await runCommand(
    'git',
    ['fetch', '--depth', '1', 'origin', ref],
    { cwd: targetDir },
  );
  if (fetch.code !== 0) {
    // Try unshallow / full fetch of ref (commit SHAs)
    fetch = await runCommand('git', ['fetch', 'origin', ref], { cwd: targetDir });
    if (fetch.code !== 0) {
      // Last resort: fetch all and checkout
      fetch = await runCommand('git', ['fetch', 'origin'], { cwd: targetDir });
    }
  }

  const checkout = await runCommand('git', ['checkout', '--force', ref], {
    cwd: targetDir,
  });
  if (checkout.code !== 0) {
    // Try FETCH_HEAD
    const co2 = await runCommand('git', ['checkout', '--force', 'FETCH_HEAD'], {
      cwd: targetDir,
    });
    if (co2.code !== 0) {
      throw new Error(
        `git checkout ref failed: ${(checkout.stderr || co2.stderr).slice(0, 400)}`,
      );
    }
  }

  const rev = await runCommand('git', ['rev-parse', 'HEAD'], { cwd: targetDir });
  if (rev.code !== 0) {
    throw new Error('Failed to resolve git commit after checkout');
  }
  return rev.stdout.trim();
}

/**
 * Install a skill package.
 *
 * @param {{
 *   name: string,
 *   sourceType: string,
 *   source: string,
 *   ref?: string,
 *   skillRoot: string,
 *   localAllowlist?: string[],
 *   subpath?: string,
 * }} opts
 */
export async function installSkill(opts) {
  const name = validateSkillName(opts.name);
  const sourceType = validateSourceType(opts.sourceType);
  const skillRoot = path.resolve(opts.skillRoot || primarySkillRoot());
  const dest = skillPackageDir(skillRoot, name);

  // Staging under skill root parent so rename is atomic on same FS when possible
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const stagingRoot = path.join(skillRoot, `.tmp-install-${token}`);
  const stagingPkg = path.join(stagingRoot, name);

  let resolvedCommit = null;
  let sourceSummary = opts.source;

  try {
    await fsp.mkdir(stagingRoot, { recursive: true });

    if (sourceType === 'local') {
      const allowed = assertLocalSourceAllowlisted(
        opts.source,
        opts.localAllowlist || [],
      );
      if (!fs.existsSync(allowed) || !fs.statSync(allowed).isDirectory()) {
        throw new Error('Local source is not a directory');
      }
      await copyTree(allowed, stagingPkg);
      sourceSummary = allowed;
    } else {
      const url = validateGitHttpsUrl(opts.source);
      const ref = validateGitRef(opts.ref);
      const cloneDir = path.join(stagingRoot, '_clone');
      resolvedCommit = await gitCloneAtRef(url, ref, cloneDir);

      const sub = opts.subpath ? String(opts.subpath).replace(/^\/+/, '') : '';
      if (sub.includes('..') || path.isAbsolute(sub)) {
        throw new Error('Invalid git subpath');
      }
      const packageSrc = sub ? path.join(cloneDir, sub) : cloneDir;
      if (!fs.existsSync(packageSrc)) {
        throw new Error(`Git subpath not found: ${sub || '(root)'}`);
      }
      await copyTree(packageSrc, stagingPkg);
      // Drop .git if copy included it
      await rmrf(path.join(stagingPkg, '.git'));
      sourceSummary = url;
    }

    const meta = validateSkillPackage(stagingPkg, { expectedName: name });
    const digest = digestDir(stagingPkg);

    await atomicReplaceDir(stagingPkg, dest);
    await rmrf(stagingRoot);

    return {
      name: meta.name,
      description: meta.description,
      path: dest,
      source_type: sourceType,
      source: sourceSummary,
      ref: sourceType === 'git' ? String(opts.ref).trim() : null,
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
 * Write or replace a single file under the skill root (development edit).
 * @param {{
 *   skillRoot: string,
 *   path: string,
 *   content: string,
 * }} opts
 */
export async function editSkillFile(opts) {
  const { resolveSkillPath } = await import('./paths.js');
  const { absolute, relative } = resolveSkillPath(opts.path, opts.skillRoot);

  // If editing SKILL.md, validate content before write
  if (path.basename(absolute) === 'SKILL.md') {
    const { parseSkillMdFrontmatter } = await import('./validator.js');
    parseSkillMdFrontmatter(opts.content);
  }

  await fsp.mkdir(path.dirname(absolute), { recursive: true });

  // Atomic write via temp file in same directory
  const tmp = `${absolute}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fsp.writeFile(tmp, opts.content, 'utf8');
    await fsp.rename(tmp, absolute);
  } catch (err) {
    await rmrf(tmp);
    throw err;
  }

  return {
    path: relative,
    absolute,
    bytes: Buffer.byteLength(opts.content, 'utf8'),
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

/** @deprecated test helper */
export function _testHelpers() {
  return { copyTree, rmrf, digestDir, runCommand, gitCloneAtRef };
}
