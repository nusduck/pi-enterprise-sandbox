/**
 * Atomic lifecycle operations for per-user Skill packages.
 *
 * New packages have exactly two trusted entry points:
 *   1. a ZIP attachment fetched by attachment id; or
 *   2. an Agent-generated package supplied as structured text files.
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
import {
  extractSkillArchive,
  SKILL_ARCHIVE_MAX_PATH_BYTES,
} from './archive.js';

export const SKILL_EDIT_MAX_BYTES = 16 * 1024 * 1024;
export const SKILL_EDIT_TIMEOUT_MS = 30_000;
export const SKILL_INSTALL_TIMEOUT_MS = 90_000;
export const SKILL_GENERATED_MAX_BYTES = 512 * 1024;
export const SKILL_GENERATED_MAX_FILES = 32;

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
 * @param {string} root
 * @param {{ deadlineAt?: number }} [opts]
 * @returns {{ dir: string, subpath: string, candidates: string[] }}
 */
export function discoverSkillPackageDir(root, opts = {}) {
  const base = path.resolve(root);
  /** @type {string[]} */
  const candidates = fs.existsSync(path.join(base, 'SKILL.md')) ? [''] : [];
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
 * @param {string} source
 * @param {string} destination
 * @param {{ deadlineAt?: number }} [opts]
 */
async function copyTree(source, destination, opts = {}) {
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

/** @param {string} dir @param {{ deadlineAt?: number }} [opts] */
function digestDir(dir, opts = {}) {
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
 * Atomically replace a package, restoring the previous version on failure.
 * @param {string} stagingDir
 * @param {string} destinationDir
 */
export async function atomicReplaceDir(stagingDir, destinationDir) {
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
async function installPreparedPackage(input) {
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
 * Install one uploaded ZIP attachment into the caller's user Skill root.
 * @param {{
 *   archiveBytes: Buffer,
 *   archiveName: string,
 *   attachmentId: string,
 *   skillRoot: string,
 *   timeoutMs?: number,
 *   systemSkillNames?: Iterable<string>,
 * }} opts
 */
export async function installSkillArchive(opts) {
  const archiveName = path.basename(String(opts.archiveName || '').trim());
  if (!archiveName.toLowerCase().endsWith('.zip')) {
    throw new Error('Skill installation accepts ZIP attachments only');
  }
  const attachmentId = String(opts.attachmentId || '').trim();
  if (!attachmentId) throw new Error('Skill archive attachment_id is required');
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
      source_type: 'upload',
      attachment_id: attachmentId,
      archive_name: archiveName,
      package_subpath: discovered.subpath || null,
      archive,
    };
  } catch (error) {
    await rmrf(stagingRoot);
    throw error;
  }
}

function normalizeDescription(value) {
  const description = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!description) throw new Error('Skill description is required');
  if (description.length > 500) {
    throw new Error('Skill description must be at most 500 characters');
  }
  return description;
}

/** @param {string} raw */
export function normalizeGeneratedFilePath(raw) {
  const value = String(raw ?? '').trim();
  if (!value || /[\x00-\x1f\x7f]/.test(value) || value.includes('\\')) {
    throw new Error('Generated Skill file path is invalid');
  }
  if (Buffer.byteLength(value, 'utf8') > SKILL_ARCHIVE_MAX_PATH_BYTES) {
    throw new Error('Generated Skill file path is too long');
  }
  if (path.isAbsolute(value) || /^[A-Za-z]:\//.test(value)) {
    throw new Error(`Generated Skill file path must be relative: ${value}`);
  }
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Generated Skill file path is unsafe: ${value}`);
  }
  if (segments.some((segment) => segment.toLowerCase() === '.git')) {
    throw new Error(`Generated Skill file path must not contain .git: ${value}`);
  }
  if (segments.join('/') === 'SKILL.md') {
    throw new Error('SKILL.md is generated from name, description and instructions');
  }
  return segments.join('/');
}

/**
 * Atomically create or replace an Agent-generated Skill package.
 * @param {{
 *   name: string,
 *   description: string,
 *   instructions: string,
 *   files?: Array<{ path: string, content: string }>,
 *   skillRoot: string,
 *   timeoutMs?: number,
 *   systemSkillNames?: Iterable<string>,
 * }} opts
 */
export async function createGeneratedSkill(opts) {
  const name = validateSkillName(opts.name);
  const description = normalizeDescription(opts.description);
  const instructions = String(opts.instructions ?? '').trim();
  if (!instructions) throw new Error('Skill instructions are required');
  const files = Array.isArray(opts.files) ? opts.files : [];
  if (files.length > SKILL_GENERATED_MAX_FILES) {
    throw new Error(`Generated Skill may contain at most ${SKILL_GENERATED_MAX_FILES} extra files`);
  }
  assertDoesNotShadowSystem(name, opts.systemSkillNames);

  const normalizedFiles = [];
  const seen = new Set(['skill.md']);
  let totalBytes = Buffer.byteLength(instructions, 'utf8');
  for (const raw of files) {
    const relative = normalizeGeneratedFilePath(raw?.path);
    const collisionKey = relative.toLocaleLowerCase('en-US');
    if (seen.has(collisionKey)) {
      throw new Error(`Generated Skill contains a duplicate file path: ${relative}`);
    }
    seen.add(collisionKey);
    const content = String(raw?.content ?? '');
    totalBytes += Buffer.byteLength(content, 'utf8');
    normalizedFiles.push({ relative, content });
  }
  if (totalBytes > SKILL_GENERATED_MAX_BYTES) {
    throw new Error(
      `Generated Skill content is ${totalBytes} bytes; maximum is ${SKILL_GENERATED_MAX_BYTES}`,
    );
  }

  const skillRoot = resolveUserSkillRoot(opts.skillRoot);
  const timeoutMs = Number.isFinite(opts.timeoutMs)
    ? Math.max(1, Number(opts.timeoutMs))
    : SKILL_INSTALL_TIMEOUT_MS;
  const deadlineAt = Date.now() + timeoutMs;
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const stagingRoot = path.join(skillRoot, `.tmp-create-${token}`);
  const packageSource = path.join(stagingRoot, '_generated');
  const stagingPackage = path.join(stagingRoot, '_package');

  try {
    await fsp.mkdir(packageSource, { recursive: true, mode: 0o700 });
    const skillMd =
      `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n` +
      `${instructions}\n`;
    await fsp.writeFile(path.join(packageSource, 'SKILL.md'), skillMd, {
      encoding: 'utf8',
      mode: 0o644,
    });
    for (const file of normalizedFiles) {
      assertBeforeDeadline(deadlineAt);
      const destination = path.join(packageSource, file.relative);
      await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
      await fsp.writeFile(destination, file.content, { encoding: 'utf8', mode: 0o644 });
    }

    const installed = await installPreparedPackage({
      packageSource,
      stagingPackage,
      skillRoot,
      deadlineAt,
      systemSkillNames: opts.systemSkillNames,
    });
    await rmrf(stagingRoot);
    return {
      ...installed,
      source_type: 'agent_generated',
      generated_files: normalizedFiles.length + 1,
      generated_bytes: totalBytes,
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

/**
 * Edit one file in an existing user Skill. This function cannot create a new
 * package; new packages must go through approved install/create operations.
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
  const skillRoot = resolveUserSkillRoot(opts.skillRoot);
  const { absolute, relative } = resolveSkillPath(opts.path, skillRoot);
  const [packageName] = relative.replace(/\\/g, '/').split('/');
  const name = validateSkillName(packageName);
  if (
    relative
      .replace(/\\/g, '/')
      .split('/')
      .some((segment) => segment.toLowerCase() === '.git')
  ) {
    throw new Error('skill_edit cannot write VCS metadata');
  }
  const packageDir = skillPackageDir(skillRoot, name);
  validateSkillPackage(packageDir, { expectedName: name });
  if (path.resolve(absolute) === path.resolve(packageDir)) {
    throw new Error('skill_edit path must name a file inside an installed Skill');
  }

  const content = typeof opts.content === 'string'
    ? opts.content
    : String(opts.content ?? '');
  const maxBytes = Number.isFinite(opts.maxBytes)
    ? Math.max(1, Number(opts.maxBytes))
    : SKILL_EDIT_MAX_BYTES;
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > maxBytes) {
    throw new Error(
      `skill_edit content is ${bytes} bytes; maximum is ${maxBytes}. ` +
        'Upload a replacement Skill ZIP for larger changes.',
    );
  }
  if (path.basename(absolute) === 'SKILL.md') {
    const metadata = parseSkillMdFrontmatter(content);
    if (metadata.name !== name) {
      throw new Error(
        `SKILL.md name "${metadata.name}" must match installed package "${name}"`,
      );
    }
  }

  await fsp.mkdir(path.dirname(absolute), { recursive: true, mode: 0o755 });
  const temporary = `${absolute}.tmp-${process.pid}-${Date.now()}`;
  const timeoutMs = Number.isFinite(opts.timeoutMs)
    ? Math.max(1, Number(opts.timeoutMs))
    : SKILL_EDIT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fsp.writeFile(temporary, content, {
      encoding: 'utf8',
      mode: 0o644,
      signal: controller.signal,
    });
    if (controller.signal.aborted) {
      throw new Error(`skill_edit timed out after ${timeoutMs}ms while writing ${relative}`);
    }
    await fsp.rename(temporary, absolute);
  } catch (error) {
    await rmrf(temporary);
    if (controller.signal.aborted || error?.name === 'AbortError') {
      throw new Error(`skill_edit timed out after ${timeoutMs}ms while writing ${relative}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
  return { path: relative, absolute, bytes };
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
 * @param {string[]} skillRoots
 * @param {{ writableRoot?: string | null }} [opts]
 */
export function describeInstalledSkills(skillRoots, opts = {}) {
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

/** Test-only helpers for failure injection and cleanup assertions. */
export function _testHelpers() {
  return { copyTree, rmrf, digestDir };
}
