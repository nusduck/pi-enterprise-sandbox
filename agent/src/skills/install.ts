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
export const SKILL_EDIT_MAX_FILES = 32;

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
    extensions: ['.zip'],
    message: 'Skill installation accepts ZIP attachments only',
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
  if (sourceType === 'upload' && !attachmentId) {
    throw new Error('Skill archive attachment_id is required');
  }
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
export async function createGeneratedSkill(opts: { name: string, description: string, instructions: string, files?: Array<{ path: string, content: string }>, skillRoot: string, timeoutMs?: number, systemSkillNames?: Iterable<string>, }) {
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
    await ensureTraversableUserSkillRoot(skillRoot);
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
 * @param raw
 * @param ctx
 */
function prepareSkillEdit(raw: { skillRoot?: string, path?: string, content?: unknown }, ctx: { resolveSkillPath: Function, skillRoot: string, maxBytes: number }) {
  const { absolute, relative } = ctx.resolveSkillPath(raw?.path, ctx.skillRoot);
  const normalized = relative.replace(/\\/g, '/');
  const [packageName] = normalized.split('/');
  const name = validateSkillName(packageName);
  if (normalized.split('/').some((segment) => segment.toLowerCase() === '.git')) {
    throw new Error('skill_edit cannot write VCS metadata');
  }
  const packageDir = skillPackageDir(ctx.skillRoot, name);
  validateSkillPackage(packageDir, { expectedName: name });
  if (path.resolve(absolute) === path.resolve(packageDir)) {
    throw new Error('skill_edit path must name a file inside an installed Skill');
  }

  const content =
    typeof raw?.content === 'string' ? raw.content : String(raw?.content ?? '');
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > ctx.maxBytes) {
    throw new Error(
      `skill_edit content for ${normalized} is ${bytes} bytes; maximum is ${ctx.maxBytes}. ` +
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
  return { name, absolute, relative: normalized, content, bytes, temporary: null };
}

/**
 * Replace one or more files inside a single installed user Skill.
 *
 * A batch is all-or-nothing. Every mutation here costs one approval, so a
 * coherent change to a package has to be proposable as one call — splitting it
 * into one call per file would either spend N approvals on one edit or let the
 * user approve a package into a half-written state. Validation runs over the
 * whole batch first, the writes land in temporaries, and only then are the
 * files swapped in; a failure part-way restores what was already swapped.
 *
 * @param {{
 *   skillRoot: string,
 *   files?: Array<{ path: string, content: string }>,
 *   path?: string,
 *   content?: string,
 *   maxBytes?: number,
 *   timeoutMs?: number,
 * }} opts
 */
export async function editSkillFiles(opts: { skillRoot: string, files?: Array<{ path: string, content: string }>, path?: string, content?: string, maxBytes?: number, timeoutMs?: number, }) {
  const { resolveSkillPath } = await import('./paths.js');
  const skillRoot = resolveUserSkillRoot(opts.skillRoot);
  const entries =
    Array.isArray(opts.files) && opts.files.length > 0
      ? opts.files
      : [{ path: opts.path, content: opts.content }];
  if (entries.every((entry) => !String(entry?.path ?? '').trim())) {
    throw new Error(
      'skill_edit requires files: [{ path, content }] naming at least one file',
    );
  }
  if (entries.length > SKILL_EDIT_MAX_FILES) {
    throw new Error(
      `skill_edit accepts at most ${SKILL_EDIT_MAX_FILES} files per call (got ${entries.length})`,
    );
  }

  const maxBytes = Number.isFinite(opts.maxBytes)
    ? Math.max(1, Number(opts.maxBytes))
    : SKILL_EDIT_MAX_BYTES;
  const ctx = { skillRoot, maxBytes, resolveSkillPath };

  const prepared = [];
  const seen = new Set();
  let packageName = null;
  for (const raw of entries) {
    const item = prepareSkillEdit(raw, ctx);
    if (packageName == null) {
      packageName = item.name;
    } else if (item.name !== packageName) {
      throw new Error(
        `skill_edit must stay inside one Skill package (got "${packageName}" and "${item.name}")`,
      );
    }
    const collisionKey = item.relative.toLocaleLowerCase('en-US');
    if (seen.has(collisionKey)) {
      throw new Error(`skill_edit lists ${item.relative} twice`);
    }
    seen.add(collisionKey);
    prepared.push(item);
  }

  const timeoutMs = Number.isFinite(opts.timeoutMs)
    ? Math.max(1, Number(opts.timeoutMs))
    : SKILL_EDIT_TIMEOUT_MS;
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const swapped: Array<{ absolute: string, backup: string | null }> = [];
  try {
    for (const item of prepared) {
      await fsp.mkdir(path.dirname(item.absolute), { recursive: true, mode: 0o755 });
      item.temporary = `${item.absolute}.tmp-${token}`;
      await fsp.writeFile(item.temporary, item.content, {
        encoding: 'utf8',
        mode: 0o644,
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        throw new Error(
          `skill_edit timed out after ${timeoutMs}ms while writing ${item.relative}`,
        );
      }
    }
    for (const item of prepared) {
      const backup = fs.existsSync(item.absolute) ? `${item.absolute}.bak-${token}` : null;
      if (backup) await fsp.rename(item.absolute, backup);
      await fsp.rename(item.temporary, item.absolute);
      item.temporary = null;
      swapped.push({ absolute: item.absolute, backup });
    }
  } catch (error) {
    for (const done of swapped.reverse()) {
      try {
        if (done.backup) await fsp.rename(done.backup, done.absolute);
        else await rmrf(done.absolute);
      } catch {
        // Surface the original failure; a restore that fails leaves the
        // backup beside the file for an operator to inspect.
      }
    }
    for (const item of prepared) {
      if (item.temporary) await rmrf(item.temporary);
    }
    if (controller.signal.aborted || error?.name === 'AbortError') {
      throw new Error(`skill_edit timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
  for (const done of swapped) {
    if (done.backup) await rmrf(done.backup);
  }

  const files = prepared.map((item) => ({
    path: item.relative,
    absolute: item.absolute,
    bytes: item.bytes,
  }));
  return {
    skill_name: packageName,
    files,
    // Single-file shape kept so existing callers and recorded tool results
    // keep reading the same fields.
    path: files[0].path,
    absolute: files[0].absolute,
    bytes: files.reduce((total, file) => total + file.bytes, 0),
  };
}

/**
 * Single-file edit. Thin wrapper over {@link editSkillFiles}.
 * @param opts
 */
export async function editSkillFile(opts: { skillRoot: string, path: string, content: string, maxBytes?: number, timeoutMs?: number }) {
  return editSkillFiles(opts);
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
