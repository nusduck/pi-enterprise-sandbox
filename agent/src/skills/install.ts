/**
 * Atomic lifecycle operations for per-user Skill packages.
 *
 * New packages have exactly two trusted entry points:
 *   1. a ZIP attachment fetched by attachment id; or
 *   2. a ZIP/.skill archive built by the Agent inside the sandbox.
 *
 * No URL, Git repository or caller-provided filesystem path is accepted.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  skillPackageDir,
  validateSkillName,
  writableSkillRoot,
} from './paths.js';
import {
  parseSkillMdFrontmatter,
  validateSkillPackage,
} from './validator.js';
import { extractSkillArchive } from './archive.js';

export const SKILL_INSTALL_TIMEOUT_MS = 90_000;

const PACKAGE_SCAN_MAX_DEPTH = 3;
const PACKAGE_SCAN_MAX_CANDIDATES = 25;

function assertBeforeDeadline(deadlineAt) {
  if (deadlineAt != null && Date.now() >= deadlineAt) {
    throw new Error(`Skill operation timed out after ${SKILL_INSTALL_TIMEOUT_MS}ms`);
  }
}

function resolveUserSkillRoot(value) {
  const raw = String(value || writableSkillRoot() || '').trim();
  if (!raw) {
    throw new Error(
      'No writable skill root is configured; installs require a per-user skill root',
    );
  }
  return path.resolve(raw);
}

/**
 * Find exactly one Skill package in an extracted archive.
 * @param root
 * @param [opts]
 * @returns {{ dir: string, subpath: string, candidates: string[] }}
 */
export function discoverSkillPackageDir(root: string, opts: { deadlineAt?: number } = {}) {
  const base = path.resolve(root);
  const candidates: string[] = fs.existsSync(path.join(base, 'SKILL.md')) ? [''] : [];
  function walk(dir, depth) {
    if (depth > PACKAGE_SCAN_MAX_DEPTH) return;
    if (candidates.length >= PACKAGE_SCAN_MAX_CANDIDATES) return;
    assertBeforeDeadline(opts.deadlineAt);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (fs.existsSync(path.join(full, 'SKILL.md'))) {
        candidates.push(path.relative(base, full).replace(/\\/g, '/'));
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
      `Skill ZIP contains no SKILL.md at its root or within ${PACKAGE_SCAN_MAX_DEPTH} levels`,
    );
  }
  throw new Error(
    `Skill ZIP must contain exactly one package; found ${candidates.length}: ` +
      `${candidates.slice(0, 10).map((item) => item || '<archive-root>').join(', ')}` +
      `${candidates.length > 10 ? ', …' : ''}`,
  );
}

/** @param {string} packageDir */
export function readSkillPackageName(packageDir) {
  const skillMd = path.join(path.resolve(packageDir), 'SKILL.md');
  if (!fs.existsSync(skillMd)) throw new Error('Missing SKILL.md in Skill package');
  return parseSkillMdFrontmatter(fs.readFileSync(skillMd, 'utf8')).name;
}

/**
 * Copy a package tree without following or reproducing links.
 * @param source
 * @param destination
 * @param [opts]
 */
async function copyTree(source: string, destination: string, opts: { deadlineAt?: number } = {}) {
  assertBeforeDeadline(opts.deadlineAt);
  const stat = await fsp.lstat(source);
  if (stat.isSymbolicLink()) {
    throw new Error(`Symbolic links are not allowed in Skill packages: ${source}`);
  }
  if (stat.isDirectory()) {
    await fsp.mkdir(destination, { recursive: true, mode: 0o755 });
    for (const entry of await fsp.readdir(source)) {
      if (entry.toLowerCase() === '.git') continue;
      await copyTree(
        path.join(source, entry),
        path.join(destination, entry),
        opts,
      );
    }
    return;
  }
  if (!stat.isFile()) {
    throw new Error(`Special filesystem entries are not allowed in Skill packages: ${source}`);
  }
  await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
  await fsp.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
  await fsp.chmod(destination, 0o644);
}

async function rmrf(target) {
  try {
    await fsp.rm(target, { recursive: true, force: true });
  } catch {
    // Cleanup is best effort; the original operation error is more useful.
  }
}

function digestDir(dir: string, opts: { deadlineAt?: number } = {}) {
  const hash = createHash('sha256');
  function walk(current) {
    assertBeforeDeadline(opts.deadlineAt);
    const entries = fs
      .readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      assertBeforeDeadline(opts.deadlineAt);
      const full = path.join(current, entry.name);
      const relative = path.relative(dir, full).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        hash.update(`d:${relative}\n`);
        walk(full);
      } else if (entry.isFile()) {
        hash.update(`f:${relative}:${fs.statSync(full).size}\n`);
        hash.update(fs.readFileSync(full));
      } else {
        throw new Error(`Skill package contains a non-regular entry: ${relative}`);
      }
    }
  }
  walk(dir);
  return hash.digest('hex').slice(0, 16);
}

/**
 * Create `<base>/<org>/<user>` so the Sandbox can traverse into it.
 *
 * This must run before any staging directory is created. `fs.mkdir` applies its
 * `mode` to **every** directory it creates on a recursive call, so
 * `mkdir('<base>/<org>/<user>/.tmp-install-x', { recursive: true, mode: 0o700 })`
 * used to stamp 0700 on `<org>` and `<user>` as a side effect of wanting a
 * private staging dir.
 *
 * Those two are the Bubblewrap bind source. The Agent owns them as `node`
 * (uid 1000); the Sandbox resolves them as uid 10001, so 0700 made
 * `realpath()` fail with EACCES — and `--ro-bind-try` only forgives ENOENT.
 * bwrap then died with `Can't find source path /home/sandbox/skill-user/...`
 * and took every bash/python launch with it, for that user, until the mode was
 * repaired. First upload of a Skill therefore broke the whole session.
 *
 * 0755 is not a weakening: it is what every other directory on this path
 * already uses. Tenant isolation comes from binding only the caller's own
 * `<org>/<user>` into the namespace, never from these bits — nothing untrusted
 * runs in either container, and untrusted code inside the sandbox only ever
 * sees its own bound directory.
 *
 * Repairs an already-broken root in place, so a user bricked by an earlier
 * install recovers on their next one.
 *
 * @param skillRoot `<base>/<org>/<user>`
 */
export async function ensureTraversableUserSkillRoot(skillRoot: string) {
  const resolved = path.resolve(skillRoot);
  await fsp.mkdir(resolved, { recursive: true, mode: 0o755 });
  // `<org>` first, then `<user>`: repairing top-down keeps every prefix
  // traversable at each step.
  for (const dir of [path.dirname(resolved), resolved]) {
    try {
      const stat = await fsp.stat(dir);
      if ((stat.mode & 0o755) !== 0o755) await fsp.chmod(dir, 0o755);
    } catch {
      // A root we cannot stat is reported by the install that follows.
    }
  }
}

/**
 * Atomically replace a package, restoring the previous version on failure.
 * @param stagingDir
 * @param destinationDir
 */
export async function atomicReplaceDir(stagingDir: string, destinationDir: string) {
  const parent = path.dirname(destinationDir);
  await fsp.mkdir(parent, { recursive: true });
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const backup = path.join(parent, `.backup-${path.basename(destinationDir)}-${token}`);
  let movedExisting = false;
  let swapped = false;
  try {
    if (!fs.existsSync(stagingDir)) {
      throw new Error('Staging directory missing before atomic replace');
    }
    if (fs.existsSync(destinationDir)) {
      await fsp.rename(destinationDir, backup);
      movedExisting = true;
    }
    await fsp.rename(stagingDir, destinationDir);
    swapped = true;
    if (movedExisting) await rmrf(backup);
  } catch (error) {
    if (swapped) await rmrf(destinationDir);
    if (movedExisting && fs.existsSync(backup)) {
      try {
        await fsp.rename(backup, destinationDir);
      } catch (restoreError) {
        throw new Error(
          `Atomic Skill replacement failed and restore failed: ${error.message}; ` +
            `restore: ${restoreError.message}`,
        );
      }
    }
    await rmrf(stagingDir);
    await rmrf(backup);
    throw error;
  }
}

function assertDoesNotShadowSystem(name, systemSkillNames) {
  const systemNames = new Set(
    systemSkillNames ? [...systemSkillNames].map(String) : [],
  );
  if (systemNames.has(name)) {
    throw new Error(
      `"${name}" is a bundled system Skill and cannot be replaced; choose another name`,
    );
  }
}

/**
 * Validate, digest and atomically install one prepared package directory.
 * @param {{
 *   packageSource: string,
 *   stagingPackage: string,
 *   skillRoot: string,
 *   deadlineAt: number,
 *   systemSkillNames?: Iterable<string>,
 * }} input
 */
async function installPreparedPackage(input: { packageSource: string, stagingPackage: string, skillRoot: string, deadlineAt: number, systemSkillNames?: Iterable<string>, }) {
  const declaredName = readSkillPackageName(input.packageSource);
  const name = validateSkillName(declaredName);
  assertDoesNotShadowSystem(name, input.systemSkillNames);

  await copyTree(input.packageSource, input.stagingPackage, {
    deadlineAt: input.deadlineAt,
  });
  const meta = validateSkillPackage(input.stagingPackage, { expectedName: name });
  const digest = digestDir(input.stagingPackage, { deadlineAt: input.deadlineAt });
  const destination = skillPackageDir(input.skillRoot, name);

  if (fs.existsSync(destination)) {
    try {
      const existing = validateSkillPackage(destination, { expectedName: name });
      const existingDigest = digestDir(destination, { deadlineAt: input.deadlineAt });
      if (existingDigest === digest) {
        await rmrf(input.stagingPackage);
        return {
          name: existing.name,
          description: existing.description,
          path: destination,
          digest: existingDigest,
          idempotent: true,
          summary: `already installed ${existing.name} digest=${existingDigest}`,
        };
      }
    } catch {
      // Invalid or changed destinations are replaced atomically below.
    }
  }

  assertBeforeDeadline(input.deadlineAt);
  await atomicReplaceDir(input.stagingPackage, destination);
  return {
    name: meta.name,
    description: meta.description,
    path: destination,
    digest,
    summary: `installed ${meta.name} digest=${digest}`,
  };
}

/**
 * Archive extensions each provenance may present.
 *
 * Uploads stay ``.zip`` only — that is the contract the composer's Skill upload
 * button and its file picker advertise. A package the model builds inside the
 * sandbox may also arrive as ``.skill``, which is the extension the bundled
 * ``skill-creator`` packaging script emits; it is the same ZIP container. The
 * extension is only a fast, legible guard either way — the bytes still have to
 * survive real ZIP extraction and package validation below.
 */
const ARCHIVE_POLICY = Object.freeze({
  upload: {
    extensions: ['.zip', '.skill'],
    message: 'Skill installation accepts .zip or .skill archives',
  },
  sandbox_build: {
    extensions: ['.zip', '.skill'],
    message: 'Skill installation accepts .zip or .skill archives',
  },
});

/** @param {unknown} raw */
export function normalizeArchiveSourceType(raw) {
  return raw === 'sandbox_build' ? 'sandbox_build' : 'upload';
}

/**
 * Validate an archive filename for one provenance and return its basename.
 *
 * Shared by the SkillManager's pre-download check and the install routine, so
 * the accepted-extension rule has exactly one definition.
 *
 * @param raw
 * @param [sourceType]
 * @returns {string}
 */
export function assertSkillArchiveName(raw: unknown, sourceType: 'upload' | 'sandbox_build' = 'upload') {
  const archiveName = path.basename(String(raw || '').trim());
  const policy = ARCHIVE_POLICY[normalizeArchiveSourceType(sourceType)];
  const lower = archiveName.toLowerCase();
  if (!policy.extensions.some((extension) => lower.endsWith(extension))) {
    throw new Error(policy.message);
  }
  return archiveName;
}

/**
 * Install one ZIP archive into the caller's user Skill root.
 *
 * The archive is either a ZIP the user attached (`sourceType: 'upload'`, keyed
 * by `attachmentId`) or one the model built inside the sandbox
 * (`sourceType: 'sandbox_build'`, keyed by `sourcePath`). Provenance only
 * changes what is recorded and which extensions are accepted — extraction,
 * package validation and the atomic replace are identical, so there is still
 * exactly one way bytes reach the Skill root.
 *
 * @param {{
 *   archiveBytes: Buffer,
 *   archiveName: string,
 *   sourceType?: 'upload' | 'sandbox_build',
 *   attachmentId?: string,
 *   sourcePath?: string,
 *   skillRoot: string,
 *   timeoutMs?: number,
 *   systemSkillNames?: Iterable<string>,
 * }} opts
 */
export async function installSkillArchive(opts: { archiveBytes: Buffer, archiveName: string, sourceType?: 'upload' | 'sandbox_build', attachmentId?: string, sourcePath?: string, skillRoot: string, timeoutMs?: number, systemSkillNames?: Iterable<string>, }) {
  const sourceType = normalizeArchiveSourceType(opts.sourceType);
  const archiveName = assertSkillArchiveName(opts.archiveName, sourceType);
  const attachmentId = String(opts.attachmentId || '').trim();
  const sourcePath = String(opts.sourcePath || '').trim();
  if (sourceType === 'sandbox_build' && !sourcePath) {
    throw new Error('Skill archive sandbox path is required');
  }
  const skillRoot = resolveUserSkillRoot(opts.skillRoot);
  const timeoutMs = Number.isFinite(opts.timeoutMs)
    ? Math.max(1, Number(opts.timeoutMs))
    : SKILL_INSTALL_TIMEOUT_MS;
  const deadlineAt = Date.now() + timeoutMs;
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const stagingRoot = path.join(skillRoot, `.tmp-install-${token}`);
  const extracted = path.join(stagingRoot, '_archive');
  const stagingPackage = path.join(stagingRoot, '_package');

  try {
    // Before the 0700 staging dir, so its mode is not stamped onto the
    // identity directories the Sandbox has to traverse.
    await ensureTraversableUserSkillRoot(skillRoot);
    await fsp.mkdir(stagingRoot, { recursive: true, mode: 0o700 });
    const archive = await extractSkillArchive(opts.archiveBytes, extracted, {
      deadlineAt,
    });
    const discovered = discoverSkillPackageDir(extracted, { deadlineAt });
    const installed = await installPreparedPackage({
      packageSource: discovered.dir,
      stagingPackage,
      skillRoot,
      deadlineAt,
      systemSkillNames: opts.systemSkillNames,
    });
    await rmrf(stagingRoot);
    return {
      ...installed,
      source_type: sourceType,
      ...(attachmentId ? { attachment_id: attachmentId } : {}),
      ...(sourcePath ? { source_path: sourcePath } : {}),
      archive_name: archiveName,
      package_subpath: discovered.subpath || null,
      archive,
    };
  } catch (error) {
    await rmrf(stagingRoot);
    throw error;
  }
}

/** @param {{ name: string, skillRoot: string }} opts */
export async function uninstallSkill(opts) {
  const name = validateSkillName(opts.name);
  const skillRoot = resolveUserSkillRoot(opts.skillRoot);
  const destination = skillPackageDir(skillRoot, name);
  if (!fs.existsSync(destination)) {
    throw new Error(
      `"${name}" is not installed in the user Skill root (bundled Skills cannot be uninstalled)`,
    );
  }
  await rmrf(destination);
  return { name, path: destination, summary: `uninstalled ${name}` };
}

/** @param {string} skillRoot */
export function listInstalledSkills(skillRoot) {
  const root = path.resolve(skillRoot);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .filter((name) => {
      try {
        validateSkillName(name);
        return fs.existsSync(path.join(root, name, 'SKILL.md'));
      } catch {
        return false;
      }
    });
}

/**
 * Describe installed packages across system and user roots. First root wins.
 * @param skillRoots
 * @param [opts]
 */
export function describeInstalledSkills(skillRoots: string[], opts: { writableRoot?: string | null } = {}) {
  const writable = opts.writableRoot ? path.resolve(opts.writableRoot) : null;
  const byName = new Map();
  for (const rawRoot of skillRoots || []) {
    const root = path.resolve(String(rawRoot));
    const tier = writable && root === writable ? 'user' : 'system';
    for (const name of listInstalledSkills(root)) {
      if (byName.has(name)) continue;
      const dir = path.join(root, name);
      let description = null;
      let invalid;
      try {
        description = validateSkillPackage(dir, { expectedName: name }).description;
      } catch (error) {
        invalid = error instanceof Error ? error.message : String(error);
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
