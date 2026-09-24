/**
 * Bounded ZIP extraction for user-uploaded Skill packages.
 *
 * Archives are untrusted input. Extraction happens only inside a fresh staging
 * directory and rejects traversal, links, duplicate paths, encrypted entries,
 * unsupported compression and zip bombs before anything reaches a Skill root.
 */
import { createWriteStream } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import yauzl from 'yauzl';

export const SKILL_ARCHIVE_MAX_BYTES = 50 * 1024 * 1024;
export const SKILL_ARCHIVE_MAX_ENTRIES = 512;
export const SKILL_ARCHIVE_MAX_FILE_BYTES = 20 * 1024 * 1024;
export const SKILL_ARCHIVE_MAX_EXPANDED_BYTES = 100 * 1024 * 1024;
export const SKILL_ARCHIVE_MAX_PATH_DEPTH = 16;
export const SKILL_ARCHIVE_MAX_PATH_BYTES = 1_024;

const ZIP_SIGNATURES = new Set([
  0x04034b50, // local file header
  0x06054b50, // empty archive / end of central directory
  0x08074b50, // spanned archive marker
]);

/** @param {Buffer} bytes */
export function assertZipArchive(bytes) {
  if (!Buffer.isBuffer(bytes)) {
    throw new Error('Skill archive bytes are required');
  }
  if (bytes.length === 0) throw new Error('Skill archive is empty');
  if (bytes.length > SKILL_ARCHIVE_MAX_BYTES) {
    throw new Error(
      `Skill archive is ${bytes.length} bytes; maximum is ${SKILL_ARCHIVE_MAX_BYTES}`,
    );
  }
  if (bytes.length < 4 || !ZIP_SIGNATURES.has(bytes.readUInt32LE(0))) {
    throw new Error('Skill archive must be a ZIP file');
  }
}

/**
 * Normalize one entry name without ever accepting a filesystem path.
 * @param raw
 * @returns {{ relative: string, directory: boolean }}
 */
export function normalizeArchiveEntryName(raw: string) {
  const name = String(raw ?? '');
  if (!name || /[\x00-\x1f\x7f]/.test(name)) {
    throw new Error('Skill archive contains an empty or invalid entry name');
  }
  if (Buffer.byteLength(name, 'utf8') > SKILL_ARCHIVE_MAX_PATH_BYTES) {
    throw new Error('Skill archive entry path is too long');
  }
  if (name.includes('\\')) {
    throw new Error(`Skill archive entry uses a backslash path: ${name}`);
  }
  if (name.startsWith('/') || /^[A-Za-z]:\//.test(name)) {
    throw new Error(`Skill archive entry uses an absolute path: ${name}`);
  }

  const directory = name.endsWith('/');
  const withoutSlash = directory ? name.slice(0, -1) : name;
  const segments = withoutSlash.split('/');
  if (
    segments.length === 0 ||
    segments.length > SKILL_ARCHIVE_MAX_PATH_DEPTH ||
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`Skill archive entry has an unsafe path: ${name}`);
  }
  if (segments.some((segment) => segment.toLowerCase() === '.git')) {
    throw new Error(`Skill archive must not contain VCS metadata: ${name}`);
  }
  return { relative: segments.join('/'), directory };
}

/** @param {import('yauzl').Entry | any} entry */
function assertRegularEntry(entry, directory) {
  if (entry.isEncrypted?.()) {
    throw new Error(`Encrypted ZIP entries are not supported: ${entry.fileName}`);
  }
  if (entry.canDecodeFileData?.() === false) {
    throw new Error(`Unsupported ZIP compression: ${entry.fileName}`);
  }

  // Unix file type bits live in the upper 16 bits of external attributes.
  const unixMode = (Number(entry.externalFileAttributes) >>> 16) & 0xffff;
  const fileType = unixMode & 0xf000;
  if (fileType === 0xa000) {
    throw new Error(`Symbolic links are not allowed in Skill archives: ${entry.fileName}`);
  }
  if (fileType !== 0 && fileType !== 0x8000 && fileType !== 0x4000) {
    throw new Error(`Special filesystem entries are not allowed: ${entry.fileName}`);
  }
  if (directory && fileType === 0x8000) {
    throw new Error(`ZIP entry type disagrees with its directory name: ${entry.fileName}`);
  }
  if (!directory && fileType === 0x4000) {
    throw new Error(`ZIP entry type disagrees with its file name: ${entry.fileName}`);
  }
}

/**
 * Extract a ZIP into an empty staging directory.
 *
 * @param bytes
 * @param destination
 * @param [opts]
 * @returns {Promise<{ entries: number, files: number, expanded_bytes: number }>}
 */
export async function extractSkillArchive(bytes: Buffer, destination: string, opts: { deadlineAt?: number } = {}) {
  assertZipArchive(bytes);
  const root = path.resolve(destination);
  await fsp.mkdir(root, { recursive: false, mode: 0o700 });

  const zip = await yauzl.fromBufferPromise(bytes, {
    lazyEntries: true,
    strictFileNames: true,
    validateEntrySizes: true,
  });
  const seen = new Set();
  let entries = 0;
  let files = 0;
  let expandedBytes = 0;

  try {
    for await (const entry of zip.eachEntry()) {
      if (opts.deadlineAt != null && Date.now() >= opts.deadlineAt) {
        throw new Error('Skill archive extraction timed out');
      }
      entries += 1;
      if (entries > SKILL_ARCHIVE_MAX_ENTRIES) {
        throw new Error(
          `Skill archive has more than ${SKILL_ARCHIVE_MAX_ENTRIES} entries`,
        );
      }

      const normalized = normalizeArchiveEntryName(entry.fileName);
      assertRegularEntry(entry, normalized.directory);
      const collisionKey = normalized.relative.toLocaleLowerCase('en-US');
      if (seen.has(collisionKey)) {
        throw new Error(`Skill archive contains a duplicate path: ${entry.fileName}`);
      }
      seen.add(collisionKey);

      const output = path.resolve(root, normalized.relative);
      if (!output.startsWith(`${root}${path.sep}`)) {
        throw new Error(`Skill archive entry escapes its staging directory: ${entry.fileName}`);
      }

      if (normalized.directory) {
        await fsp.mkdir(output, { recursive: true, mode: 0o755 });
        continue;
      }

      const declared = Number(entry.uncompressedSize);
      if (!Number.isSafeInteger(declared) || declared < 0) {
        throw new Error(`Skill archive entry has an invalid size: ${entry.fileName}`);
      }
      if (declared > SKILL_ARCHIVE_MAX_FILE_BYTES) {
        throw new Error(
          `Skill archive entry exceeds ${SKILL_ARCHIVE_MAX_FILE_BYTES} bytes: ${entry.fileName}`,
        );
      }
      expandedBytes += declared;
      if (expandedBytes > SKILL_ARCHIVE_MAX_EXPANDED_BYTES) {
        throw new Error(
          `Skill archive expands beyond ${SKILL_ARCHIVE_MAX_EXPANDED_BYTES} bytes`,
        );
      }

      await fsp.mkdir(path.dirname(output), { recursive: true, mode: 0o755 });
      const input = await zip.openReadStreamPromise(entry);
      let actual = 0;
      const signal = opts.deadlineAt == null
        ? undefined
        : AbortSignal.timeout(Math.max(1, opts.deadlineAt - Date.now()));
      const limiter = new Transform({
        transform(chunk, _encoding, callback) {
          actual += chunk.length;
          if (actual > SKILL_ARCHIVE_MAX_FILE_BYTES || actual > declared) {
            callback(new Error(`Skill archive entry size mismatch: ${entry.fileName}`));
            return;
          }
          callback(null, chunk);
        },
      });
      try {
        await pipeline(
          input,
          limiter,
          createWriteStream(output, { flags: 'wx', mode: 0o644 }),
          ...(signal ? [{ signal }] : []),
        );
      } catch (error) {
        await fsp.rm(output, { force: true }).catch(() => {});
        if (signal?.aborted) {
          throw new Error('Skill archive extraction timed out');
        }
        throw error;
      }
      if (actual !== declared) {
        throw new Error(`Skill archive entry size mismatch: ${entry.fileName}`);
      }
      files += 1;
    }
  } finally {
    zip.close();
  }

  if (files === 0) throw new Error('Skill archive contains no files');
  return { entries, files, expanded_bytes: expandedBytes };
}
