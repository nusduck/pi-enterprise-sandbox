/**
 * 控制面存储底座。移植自 `sandbox/services/control_plane_storage.py` 里
 * 产物路径所需的部分（`stream_copy_hash_*` / `open_control_file_read` /
 * `artifact_blob_path` / `FileIdentity`）。
 *
 * **为什么快照不放工作区**：工作区是模型可写的。产物的意义是"提交那一刻的
 * 不可变快照"，放在模型能改能删的地方，这个意义就没了。控制面根由服务进程
 * 独占（0700），沙箱子进程的挂载表里根本没有它。
 *
 * 三条防线，逐条对应 Python，去掉任何一条都会让"快照"退化成"一个副本"：
 *
 * 1. **`O_NOFOLLOW`**：控制面路径上的符号链接一律拒绝，不跟随。
 * 2. **拷贝前后各校验一次源 identity**（dev/ino/size/mtime/nlink）——拷到
 *    一半源文件被换掉，得到的快照就是两个文件的拼接；这两次校验把它变成
 *    一个明确的 `IDENTITY_MISMATCH`，而不是一份静默损坏的产物。
 * 3. **先写 `.tmp` 再 `rename`**：中途失败不会留下截断的最终文件。
 *
 * ## Model Experience
 * 模型看不到本文件。它看到的是 `submit_artifact` 成功后的 sha256/size，
 * 以及失败时的稳定错误码（`TOO_LARGE` / `NOT_REGULAR_FILE` / `SYMLINK_REJECTED`
 * / `IDENTITY_MISMATCH`）——这些码经 `bridge-client` 的封闭表翻译成人话。
 *
 * ## Known Limitations and Deferred Work
 * - 不消除 TOCTOU（与 ADR 0008 的取舍一致）：identity 校验缩小窗口，不关闭它。
 * - `O_NOFOLLOW` 只保护最后一段。中间目录段的符号链接需要 `openat2`
 *   （Linux 专有），Python 版用 dirfd 逐段走；这里的控制面根不对外可写，
 *   风险面比工作区侧小，暂按当前形态。
 */
import { constants as fsConstants } from 'node:fs';
import { open, mkdir, rename, unlink, lstat, chmod } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const CHUNK = 1024 * 1024;

/** `O_NOFOLLOW` 在非 POSIX 上可能没有；取不到时退化为 0（不加这个位）。 */
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const FILE_READ = fsConstants.O_RDONLY | O_NOFOLLOW;
const FILE_WRITE_EXCL =
  fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW;

export class ControlPlaneError extends Error {
  override name = 'ControlPlaneError';
  constructor(
    readonly code: string,
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
  }
}

export interface ControlPlaneRoots {
  /** 产物快照根，对应 `SANDBOX_ARTIFACTS_ROOT`。 */
  readonly artifactsRoot: string;
  /** 其它控制面数据根，对应 `SANDBOX_CONTROL_ROOT`。 */
  readonly controlRoot: string;
}

export function readControlPlaneRoots(env: NodeJS.ProcessEnv = process.env): ControlPlaneRoots {
  return {
    artifactsRoot: env['SANDBOX_ARTIFACTS_ROOT'] ?? '/var/sandbox/artifacts',
    controlRoot: env['SANDBOX_CONTROL_ROOT'] ?? '/var/sandbox/control',
  };
}

/** 建控制面根，权限 0700（只有服务进程自己能进）。 */
export async function ensureControlRoots(roots: ControlPlaneRoots): Promise<void> {
  for (const root of [roots.artifactsRoot, roots.controlRoot]) {
    await mkdir(root, { recursive: true });
    await chmod(root, 0o700).catch(() => {
      // 挂载点可能不允许改权限；不因此让提交失败。
    });
  }
}

/** 单个路径段校验：不接受空串、`.`、`..`、分隔符与空字节。 */
export function validateSegment(seg: string, field = 'path'): string {
  if (!seg || typeof seg !== 'string') {
    throw new ControlPlaneError('PATH_INVALID', `invalid ${field}`);
  }
  if (seg === '.' || seg === '..' || seg.includes('/') || seg.includes('\\') || seg.includes('\0')) {
    throw new ControlPlaneError('PATH_INVALID', `invalid ${field} segment`);
  }
  return seg;
}

/** `<artifactsRoot>/<orgId>/<artifactId>/blob`——按 org 分片，与 Python 一致。 */
export function artifactBlobPath(
  roots: ControlPlaneRoots,
  orgId: string,
  artifactId: string,
): string {
  return path.join(
    roots.artifactsRoot,
    validateSegment(orgId, 'org_id'),
    validateSegment(artifactId, 'artifact_id'),
    'blob',
  );
}

/**
 * 文件身份：dev/ino/size/mtime/nlink。
 *
 * 这是"这还是同一个文件吗"的判据，不是完整性凭证（那是 sha256 的活）。
 * 它能发现替换、截断、重命名覆盖，发现不了"内容被改成同样长度且 mtime 被
 * 伪造成一样"——那种情况下 sha256 才是答案。
 */
export interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeNs: string;
  readonly nlink: number;
  readonly sha256?: string | undefined;
}

interface BigIntStats {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  nlink: bigint;
  mode: bigint;
}

async function statBig(handle: FileHandle): Promise<BigIntStats> {
  const st = await handle.stat({ bigint: true });
  return {
    dev: st.dev,
    ino: st.ino,
    size: st.size,
    mtimeNs: st.mtimeNs,
    nlink: st.nlink,
    mode: st.mode,
  };
}

function identityOf(st: BigIntStats, sha256?: string): FileIdentity {
  return {
    dev: Number(st.dev),
    ino: Number(st.ino),
    size: Number(st.size),
    mtimeNs: st.mtimeNs.toString(),
    nlink: Number(st.nlink),
    ...(sha256 !== undefined ? { sha256 } : {}),
  };
}

export function identityMatches(
  identity: FileIdentity,
  st: BigIntStats,
  checkMtime = true,
): boolean {
  if (
    Number(st.dev) !== identity.dev ||
    Number(st.ino) !== identity.ino ||
    Number(st.size) !== identity.size ||
    Number(st.nlink) !== identity.nlink
  ) {
    return false;
  }
  return !checkMtime || st.mtimeNs.toString() === identity.mtimeNs;
}

const S_IFMT = 0o170000n;
const S_IFREG = 0o100000n;

function isRegular(st: BigIntStats): boolean {
  return (st.mode & S_IFMT) === S_IFREG;
}

/** 以 `O_NOFOLLOW` 打开一个已存在的普通文件读。调用方负责 close。 */
export async function openControlFileRead(target: string): Promise<FileHandle> {
  let handle: FileHandle;
  try {
    handle = await open(target, FILE_READ);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new ControlPlaneError('FILE_NOT_FOUND', 'control-plane file not found', 404);
    }
    if (code === 'ELOOP' || code === 'EMLINK') {
      throw new ControlPlaneError('SYMLINK_REJECTED', 'symlink rejected in control-plane path');
    }
    throw new ControlPlaneError('OPEN_FAILED', 'failed to open control-plane file');
  }
  const st = await statBig(handle);
  if (!isRegular(st)) {
    await handle.close().catch(() => {});
    throw new ControlPlaneError('NOT_REGULAR_FILE', 'not a regular file');
  }
  return handle;
}

/** 只删控制面的普通文件/符号链接本身，绝不跟随到目标。 */
export async function unlinkControlFile(target: string): Promise<void> {
  try {
    const st = await lstat(target);
    if (st.isSymbolicLink() || st.isFile()) await unlink(target);
  } catch {
    // 不存在或删不掉都不是错误：调用方是在做清理。
  }
}

export interface CopyResult {
  readonly digest: string;
  readonly size: number;
  readonly identity: FileIdentity;
}

/**
 * 把 `srcPath` 边读边算 sha256 拷进控制面 `destFinal`。
 *
 * 顺序照抄 Python，每一步都有理由：
 * 先清 `.tmp` 残留 → fstat 源并校验（普通文件、非多硬链接）→ 记 identity →
 * 写 `.tmp`（O_EXCL 0600）→ 比对声明大小与实际写入 → fsync →
 * **再 fstat 源确认 identity 没变** → rename → fsync 父目录 → 复读确认大小。
 */
export async function streamCopyHashToControl(
  srcPath: string,
  destFinal: string,
  options: { maxBytes: number; roots: ControlPlaneRoots },
): Promise<CopyResult> {
  await ensureControlRoots(options.roots);
  await mkdir(path.dirname(destFinal), { recursive: true, mode: 0o700 });

  const tmp = `${destFinal}.tmp`;
  await unlinkControlFile(tmp);

  let src: FileHandle;
  try {
    src = await open(srcPath, FILE_READ);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') {
      throw new ControlPlaneError('SYMLINK_REJECTED', 'artifact source must not be a symlink');
    }
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new ControlPlaneError('FILE_NOT_FOUND', 'artifact source file not found', 404);
    }
    throw new ControlPlaneError('SOURCE_OPEN_FAILED', 'failed to open source file');
  }

  try {
    const st0 = await statBig(src);
    if (!isRegular(st0)) {
      throw new ControlPlaneError('NOT_REGULAR_FILE', 'source is not a regular file');
    }
    if (Number(st0.nlink) > 1) {
      throw new ControlPlaneError('HARDLINK_REJECTED', 'source must not be multi-linked');
    }
    const ident0 = identityOf(st0);

    const hash = createHash('sha256');
    let total = 0;
    let out: FileHandle | null = null;
    try {
      out = await open(tmp, FILE_WRITE_EXCL, 0o600);
      const buf = Buffer.alloc(CHUNK);
      let position = 0;
      for (;;) {
        const { bytesRead } = await src.read(buf, 0, CHUNK, position);
        if (bytesRead === 0) break;
        position += bytesRead;
        total += bytesRead;
        if (total > options.maxBytes) {
          throw new ControlPlaneError('TOO_LARGE', 'file exceeds max size', 413);
        }
        const slice = buf.subarray(0, bytesRead);
        hash.update(slice);
        await out.write(slice, 0, bytesRead);
      }
      const stOut = await statBig(out);
      if (Number(stOut.size) !== total) {
        throw new ControlPlaneError(
          'SIZE_MISMATCH',
          `written size ${Number(stOut.size)} != streamed total ${total}`,
          500,
        );
      }
      await out.sync();
    } catch (err) {
      await out?.close().catch(() => {});
      out = null;
      await unlink(tmp).catch(() => {});
      throw err;
    } finally {
      await out?.close().catch(() => {});
    }

    // 全部读完后，源必须还是同一个文件——否则快照可能是两份内容的拼接。
    let st1: BigIntStats;
    try {
      st1 = await statBig(src);
    } catch {
      await unlink(tmp).catch(() => {});
      throw new ControlPlaneError('IDENTITY_MISMATCH', 'source vanished during copy', 409);
    }
    if (!identityMatches(ident0, st1)) {
      await unlink(tmp).catch(() => {});
      throw new ControlPlaneError('IDENTITY_MISMATCH', 'source identity changed during copy', 409);
    }

    try {
      await rename(tmp, destFinal);
    } catch {
      await unlink(tmp).catch(() => {});
      throw new ControlPlaneError('PUBLISH_FAILED', 'atomic snapshot rename failed', 500);
    }

    // 目录项本身也要落盘，否则崩溃后可能只有 tmp 名字。
    await syncDir(path.dirname(destFinal));

    const verify = await openControlFileRead(destFinal);
    try {
      const st2 = await statBig(verify);
      const digest = hash.digest('hex');
      if (Number(st2.size) !== total) {
        await unlink(destFinal).catch(() => {});
        throw new ControlPlaneError('SIZE_MISMATCH', 'snapshot size mismatch', 500);
      }
      return { digest, size: total, identity: identityOf(st2, digest) };
    } finally {
      await verify.close().catch(() => {});
    }
  } finally {
    await src.close().catch(() => {});
  }
}

async function syncDir(dir: string): Promise<void> {
  try {
    const handle = await open(dir, fsConstants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close().catch(() => {});
    }
  } catch {
    // 有些文件系统不支持对目录 fsync；不因此让一次成功的提交失败。
  }
}

/**
 * 流式读控制面快照，只校验 identity，不重算整份哈希。
 *
 * 快照在不可信工作区之外，内容对沙箱子进程不可变；identity（dev/ino/size/
 * mtime）足以发现被替换或掉包。重算哈希对大产物是白付出的成本。
 */
export async function* iterSnapshotChunks(
  target: string,
  expected?: FileIdentity | undefined,
): AsyncGenerator<Buffer> {
  const handle = await openControlFileRead(target);
  try {
    const st = await statBig(handle);
    if (expected !== undefined && !identityMatches(expected, st)) {
      throw new ControlPlaneError('IDENTITY_MISMATCH', 'artifact snapshot identity changed', 409);
    }
    const buf = Buffer.alloc(CHUNK);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buf, 0, CHUNK, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      yield Buffer.from(buf.subarray(0, bytesRead));
    }
  } finally {
    await handle.close().catch(() => {});
  }
}
