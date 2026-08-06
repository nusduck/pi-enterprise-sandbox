/**
 * User-installed skills, stored durably and materialised locally on demand.
 *
 * The filesystem copy used to *be* the skill: installed to a volume that every
 * Agent worker wrote to, which forced ReadWriteMany and left the content with
 * no authority — lose the volume, or race two workers, and nothing could say
 * what a user actually had installed.
 *
 * Here MySQL is the authority and each pod keeps a local read-only copy it can
 * rebuild. That turns the volume into a cache (an `emptyDir` is enough) and
 * makes "what is installed" a question with one answer.
 *
 * Bundles are gzipped tars of the package directory, addressed by content
 * digest. A pod extracts only when its local digest differs, so a warm cache
 * costs one small query per run rather than an extraction.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { ulid } from '../domain/shared/ulid.js';

export const USER_SKILLS_TABLE = 'user_skills';

/** Written beside a materialised skill so the next run can skip extraction. */
export const DIGEST_MARKER = '.bundle-sha256';

/** MEDIUMBLOB ceiling. A skill near this is a packaging mistake, not a skill. */
export const MAX_BUNDLE_BYTES = 16 * 1024 * 1024;

const TAR_TIMEOUT_MS = 30_000;

function toMysqlDateTime(date = new Date()) {
  return date.toISOString().slice(0, 23).replace('T', ' ');
}

/**
 * Run tar, collecting stdout. Uses the binary rather than a JS tar library so
 * symlink, permission and hardlink handling match what the installer produced.
 */
function runTar(args, { cwd, collect = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', args, {
      cwd,
      stdio: ['ignore', collect ? 'pipe' : 'ignore', 'pipe'],
    });
    const out = [];
    const err = [];
    child.stdout?.on('data', (chunk) => out.push(chunk));
    child.stderr?.on('data', (chunk) => err.push(chunk));

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('tar timed out'));
    }, TAR_TIMEOUT_MS);
    timer.unref?.();

    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(
            `tar exited ${code}: ${Buffer.concat(err).toString('utf8').slice(0, 300)}`,
          ),
        );
        return;
      }
      resolve(collect ? Buffer.concat(out) : Buffer.alloc(0));
    });
  });
}

/**
 * Content digest of a package directory.
 *
 * Computed from the tree rather than the archive bytes: tar output varies with
 * implementation and ordering (GNU vs bsdtar, `--sort` support), so hashing the
 * archive would make an unchanged skill look different on a different host and
 * invalidate every pod's cache. Hashing sorted (path, mode, content) is stable
 * everywhere and is what the cache actually cares about.
 *
 * @param {string} packageDir
 * @returns {Promise<string>}
 */
export async function digestPackageDir(packageDir) {
  const root = path.resolve(packageDir);
  const hash = createHash('sha256');

  /** @param {string} dir */
  async function walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      // The marker records the digest; including it would make the digest
      // depend on itself.
      if (entry.name === DIGEST_MARKER) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (entry.isDirectory()) {
        hash.update(`d\0${rel}\0`);
        // eslint-disable-next-line no-await-in-loop
        await walk(full);
      } else if (entry.isSymbolicLink()) {
        // eslint-disable-next-line no-await-in-loop
        const target = await fsp.readlink(full);
        hash.update(`l\0${rel}\0${target}\0`);
      } else if (entry.isFile()) {
        // eslint-disable-next-line no-await-in-loop
        const [stat, content] = await Promise.all([
          fsp.stat(full),
          fsp.readFile(full),
        ]);
        // Mode matters: an executable script that loses its bit is a different
        // skill even with identical bytes.
        hash.update(`f\0${rel}\0${stat.mode & 0o777}\0`);
        hash.update(content);
      }
    }
  }

  await walk(root);
  return hash.digest('hex');
}

/**
 * Pack a skill package directory into a gzipped tar.
 *
 * Only portable tar flags are used so this behaves the same under GNU tar in
 * the container and bsdtar on a developer machine. Determinism lives in
 * {@link digestPackageDir}, not in the archive.
 *
 * @param {string} packageDir
 * @returns {Promise<{ bundle: Buffer, sha256: string, sizeBytes: number }>}
 */
export async function packSkillBundle(packageDir) {
  const resolved = path.resolve(packageDir);
  if (!fs.existsSync(resolved)) {
    throw new Error(`skill package directory not found: ${resolved}`);
  }
  const bundle = await runTar(['-czf', '-', '-C', resolved, '.'], {
    collect: true,
  });
  if (bundle.byteLength > MAX_BUNDLE_BYTES) {
    throw new Error(
      `skill bundle is ${bundle.byteLength} bytes, over the ${MAX_BUNDLE_BYTES} limit`,
    );
  }
  return {
    bundle,
    sha256: await digestPackageDir(resolved),
    sizeBytes: bundle.byteLength,
  };
}

/**
 * Extract a bundle into `destDir`, replacing whatever is there.
 *
 * Extraction goes to a sibling staging directory and is renamed into place, so
 * a run never observes a half-written skill.
 */
export async function unpackSkillBundle(bundle, destDir, { digest } = {}) {
  const resolved = path.resolve(destDir);
  const staging = `${resolved}.tmp-${process.pid}-${Date.now()}`;
  await fsp.mkdir(staging, { recursive: true });

  try {
    await new Promise((resolve, reject) => {
      const child = spawn('tar', ['-xzf', '-', '-C', staging], {
        stdio: ['pipe', 'ignore', 'pipe'],
      });
      const err = [];
      child.stderr?.on('data', (chunk) => err.push(chunk));
      child.once('error', reject);
      child.once('close', (code) => {
        if (code !== 0) {
          reject(
            new Error(
              `tar extract exited ${code}: ${Buffer.concat(err)
                .toString('utf8')
                .slice(0, 300)}`,
            ),
          );
          return;
        }
        resolve(undefined);
      });
      child.stdin.end(bundle);
    });

    if (digest) {
      await fsp.writeFile(path.join(staging, DIGEST_MARKER), digest, 'utf8');
    }

    await fsp.rm(resolved, { recursive: true, force: true });
    await fsp.rename(staging, resolved);
  } finally {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

/** Digest of the local copy, or null when absent or unmarked. */
export async function readLocalDigest(skillDir) {
  try {
    const marker = await fsp.readFile(
      path.join(skillDir, DIGEST_MARKER),
      'utf8',
    );
    return marker.trim() || null;
  } catch {
    return null;
  }
}

/**
 * @param {object} deps
 * @param {import('knex').Knex} deps.db
 * @param {() => Date} [deps.now]
 */
export function createSkillBundleStore({ db, now = () => new Date() }) {
  if (!db) throw new Error('createSkillBundleStore requires a knex executor');

  function scoped(scope) {
    const orgId = String(scope?.orgId ?? '').trim();
    const userId = String(scope?.userId ?? '').trim();
    if (!orgId || !userId) {
      // Skills are per-user by design; an unscoped write would put one user's
      // install into everyone's context.
      throw new Error('skill bundle operations require orgId and userId');
    }
    return { orgId, userId };
  }

  return {
    /** Persist (or replace) one skill's bundle. */
    async put(scope, skillName, { bundle, sha256: digest, sizeBytes, source }) {
      const { orgId, userId } = scoped(scope);
      const timestamp = toMysqlDateTime(now());
      const row = {
        org_id: orgId,
        user_id: userId,
        skill_name: skillName,
        bundle,
        sha256: digest,
        size_bytes: sizeBytes,
        source_type: source?.sourceType ?? null,
        source: source?.source ?? null,
        resolved_commit: source?.resolvedCommit ?? null,
        updated_at: timestamp,
      };
      await db(USER_SKILLS_TABLE)
        .insert({ ...row, user_skill_id: ulid(), created_at: timestamp })
        // Reinstalling replaces in place, matching the atomic directory swap
        // the filesystem installer already performed.
        .onConflict(['org_id', 'user_id', 'skill_name'])
        .merge(row);
      return digest;
    },

    async remove(scope, skillName) {
      const { orgId, userId } = scoped(scope);
      return db(USER_SKILLS_TABLE)
        .where({ org_id: orgId, user_id: userId, skill_name: skillName })
        .del();
    },

    /** Names and digests only — cheap enough to call before every run. */
    async listDigests(scope) {
      const { orgId, userId } = scoped(scope);
      const rows = await db(USER_SKILLS_TABLE)
        .where({ org_id: orgId, user_id: userId })
        .select('skill_name', 'sha256');
      return rows.map((r) => ({ skillName: r.skill_name, sha256: r.sha256 }));
    },

    async getBundle(scope, skillName) {
      const { orgId, userId } = scoped(scope);
      const row = await db(USER_SKILLS_TABLE)
        .where({ org_id: orgId, user_id: userId, skill_name: skillName })
        .first('bundle', 'sha256');
      return row ? { bundle: row.bundle, sha256: row.sha256 } : null;
    },
  };
}

/**
 * Bring a user's local skill directory in line with the durable store.
 *
 * Extracts only what changed and removes what no longer exists, so a pod that
 * has never seen this user pays a full materialisation once and nothing after.
 *
 * Failure is reported, not thrown: skills are an enhancement to a run, and a
 * transient database problem should not stop the run from executing at all.
 *
 * @returns {Promise<{ materialised: string[], removed: string[], failed: string[] }>}
 */
export async function materialiseUserSkills({
  store,
  scope,
  userSkillDir,
  logger = console,
}) {
  const result = { materialised: [], removed: [], failed: [] };

  let wanted;
  try {
    wanted = await store.listDigests(scope);
  } catch (err) {
    logger.warn?.(
      `[skills] cannot list durable skills: ${
        err instanceof Error ? err.message : 'error'
      }`,
    );
    return result;
  }

  await fsp.mkdir(userSkillDir, { recursive: true });
  const wantedByName = new Map(wanted.map((w) => [w.skillName, w.sha256]));

  for (const { skillName, sha256: digest } of wanted) {
    const skillDir = path.join(userSkillDir, skillName);
    // eslint-disable-next-line no-await-in-loop
    if ((await readLocalDigest(skillDir)) === digest) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      const record = await store.getBundle(scope, skillName);
      if (!record) continue;
      // eslint-disable-next-line no-await-in-loop
      await unpackSkillBundle(record.bundle, skillDir, { digest: record.sha256 });
      result.materialised.push(skillName);
    } catch (err) {
      result.failed.push(skillName);
      logger.warn?.(
        `[skills] failed to materialise ${skillName}: ${
          err instanceof Error ? err.message : 'error'
        }`,
      );
    }
  }

  // Drop local copies of skills the user has since uninstalled. Without this a
  // pod would keep serving a skill that no longer exists anywhere else.
  let localEntries = [];
  try {
    localEntries = await fsp.readdir(userSkillDir, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of localEntries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (wantedByName.has(entry.name)) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      await fsp.rm(path.join(userSkillDir, entry.name), {
        recursive: true,
        force: true,
      });
      result.removed.push(entry.name);
    } catch {
      // A stale directory is less harmful than aborting materialisation.
    }
  }

  return result;
}
