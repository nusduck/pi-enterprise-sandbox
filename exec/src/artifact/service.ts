/**
 * 产物提交 / 列举 / 下载 / 导入。移植自 Python 版
 * `sandbox/artifact/infrastructure/manager.py` + `application/facade.py`。
 *
 * **快照存控制面，不存工作区。** 早前的 TS 版把产物写进
 * `工作区/artifacts/{id}/{name}`，而工作区是模型可写的——模型能改写甚至删掉
 * 自己已提交的产物，"提交那一刻的不可变快照"这个语义就不成立了。现在走
 * `control-plane-storage.ts`，沙箱子进程的挂载表里没有控制面根。
 *
 * ## Model Experience
 * `submit` 返回真实字节的 `sha256` 与 `size`；模型可以据此确认自己交付的东西
 * 就是它以为的那个。失败是稳定错误码（见 `control-plane-storage.ts`），
 * 不是自由文本，所以重试策略是可学的。
 *
 * ## Known Limitations and Deferred Work
 * - `source_execution_id` 溯源（Python `source_provenance`）未移植：它依赖
 *   agent 侧的执行记账，跨面契约要单独定。
 * - `delete_by_session` 未移植：目前没有调用方。
 */

import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { WorkspaceContext } from '../types.js';
import { redactPhysicalRoots } from '../fs/redact.js';
import type { WorkspaceFileSystem } from '../fs/workspace-fs.js';
import { sanitizeFilename } from '../attachment/sanitize.js';
import type {
  ArtifactStore,
  ExecArtifactRecord,
  OwnerScope,
} from '../db/repositories/artifacts.js';
import { InMemoryArtifactStore } from '../db/repositories/artifacts.js';
import { InMemoryQuotaStore } from '../workspace/quota-store.js';
import { InProcessWorkspaceLock } from '../workspace/lock.js';
import { WorkspaceQuotaLedger } from '../workspace/quota-ledger.js';
import {
  ControlPlaneError,
  artifactBlobPath,
  iterSnapshotChunks,
  readControlPlaneRoots,
  streamCopyHashToControl,
  unlinkControlFile,
  type ControlPlaneRoots,
} from './control-plane-storage.js';

export class ArtifactError extends Error {
  override name = 'ArtifactError';
  constructor(
    readonly code: string,
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
  }
}

/** 产物默认上限：与 Python `settings.artifact_max_bytes` 同量级。 */
const DEFAULT_MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;

/**
 * 浏览器会把这几种类型当页面执行。产物是用户生成的内容，直接以原 MIME 下发
 * 等于给自己开一个存储型 XSS，所以下发时降级成 `octet-stream`。
 * 与 Python `public.py` 的同名判断逐条一致。
 */
const EXECUTABLE_MIME = new Set(['text/html', 'application/xhtml+xml', 'image/svg+xml']);

export function downloadMimeType(mime: string | null | undefined): string {
  const value = (mime ?? '').trim() || 'application/octet-stream';
  return EXECUTABLE_MIME.has(value.toLowerCase()) ? 'application/octet-stream' : value;
}

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.zip': 'application/zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function guessMime(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  return MIME_BY_EXT[name.slice(dot).toLowerCase()] ?? 'application/octet-stream';
}

export interface ArtifactSubmitRequest {
  readonly workspace: WorkspaceContext;
  readonly sessionId: string;
  /** 工作区内已存在的逻辑源路径。 */
  readonly sourcePath: string;
  /** 用户可见显示名；不传则从 sourcePath 推导。 */
  readonly name?: string | null;
  readonly mimeType?: string | null;
  /** 提交方声明的摘要；不匹配即拒。 */
  readonly expectedSha256?: string | null;
  /** 提交时用调用方身份，不信任 body 里的 org/user。 */
  readonly owner: OwnerScope;
  /**
   * 由调用方指定的 artifact id。只有 MCP 窄桥用：facade 先生成 ULID、写进
   * 自己的 Redis 元数据并签进下载 URL，之后才调过来——exec 这边再生成一个
   * 新 id，两边就对不上了。其余调用方一律不传，由本服务生成。
   */
  readonly externalArtifactId?: string | null;
}

export interface ArtifactServiceOptions {
  readonly roots?: ControlPlaneRoots;
  readonly maxBytes?: number;
  readonly quotaLedger?: WorkspaceQuotaLedger;
}

export class ArtifactService {
  readonly #roots: ControlPlaneRoots;
  readonly #maxBytes: number;
  readonly #quotaLedger: WorkspaceQuotaLedger;

  constructor(
    private readonly fsFactory: (workspace: WorkspaceContext) => WorkspaceFileSystem,
    private readonly store: ArtifactStore = new InMemoryArtifactStore(),
    options: ArtifactServiceOptions = {},
  ) {
    this.#roots = options.roots ?? readControlPlaneRoots();
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
    this.#quotaLedger =
      options.quotaLedger ??
      new WorkspaceQuotaLedger(new InMemoryQuotaStore(), new InProcessWorkspaceLock(), {
        defaultQuotaMb: 1024,
      });
  }

  #redact(err: unknown, workspace: WorkspaceContext): never {
    const roots = [workspace.workspaceRoot, workspace.tempRoot, this.#roots.artifactsRoot];
    const msg = err instanceof Error ? err.message : String(err);
    const redacted = redactPhysicalRoots(msg, roots);
    if (err instanceof ArtifactError) throw new ArtifactError(err.code, redacted, err.status);
    if (err instanceof ControlPlaneError) throw new ArtifactError(err.code, redacted, err.status);
    throw new Error(redacted);
  }

  async submit(req: ArtifactSubmitRequest): Promise<ExecArtifactRecord> {
    try {
      return await this.#submitInner(req);
    } catch (err) {
      this.#redact(err, req.workspace);
    }
  }

  async #submitInner(req: ArtifactSubmitRequest): Promise<ExecArtifactRecord> {
    const { workspace, sourcePath } = req;
    if (!sourcePath || sourcePath.trim() === '') {
      throw new ArtifactError('artifact_path_required', 'artifact source_path is required', 400);
    }
    const displayName = (req.name ?? '').trim() || (sourcePath.split('/').pop() ?? 'artifact');
    const safeName = sanitizeFilename(displayName);
    if (!safeName) throw new ArtifactError('artifact_bad_name', 'artifact name is invalid', 400);

    // 围栏只有一处：源路径经 WorkspaceFileSystem.resolve()，不自己拼物理路径。
    const fs = this.fsFactory(workspace);
    const target = await fs.resolve(sourcePath);

    const artifactId =
      (req.externalArtifactId ?? '').trim() || `art_${randomUUID().replace(/-/g, '')}`;
    const dest = artifactBlobPath(this.#roots, req.owner.orgId, artifactId);

    const copied = await streamCopyHashToControl(target.targetKey, dest, {
      maxBytes: this.#maxBytes,
      roots: this.#roots,
    });

    if (req.expectedSha256 && req.expectedSha256.toLowerCase() !== copied.digest) {
      // 声明与实际不符：删掉快照再拒，不留下一个没人认领的产物。
      await unlinkControlFile(dest);
      throw new ArtifactError(
        'artifact_digest_mismatch',
        'artifact sha256 does not match expected_sha256',
        409,
      );
    }

    // 快照落在控制面，不占工作区配额；但产物总量仍然要记账，否则一个会话
    // 可以用无限次 submit 把控制面盘写满。
    const reservation = await this.#quotaLedger.reserve(
      workspace.workspaceRoot,
      workspace.workspaceId,
      copied.size,
    );
    try {
      await reservation.commit();
    } catch (err) {
      await reservation.release().catch(() => {});
      await unlinkControlFile(dest);
      throw err;
    }

    await this.store.insert({
      artifactId,
      sessionId: req.sessionId,
      workspaceId: workspace.workspaceId,
      orgId: req.owner.orgId,
      userId: req.owner.userId,
      name: displayName,
      sourcePath,
      mimeType: (req.mimeType ?? '').trim() || guessMime(safeName),
      sha256: copied.digest,
      sizeBytes: copied.size,
      identity: copied.identity,
    });

    const got = await this.store.getOwned(artifactId, req.owner);
    if (!got) throw new ArtifactError('artifact_not_found', 'artifact insert not visible', 500);
    return got;
  }

  async list(sessionId: string, owner: OwnerScope): Promise<ExecArtifactRecord[]> {
    return await this.store.listBySession(sessionId, owner);
  }

  /** 取产物元数据；归属不符返回 null（调用方一律翻成 404，不泄漏存在性）。 */
  async get(artifactId: string, owner: OwnerScope): Promise<ExecArtifactRecord | null> {
    return await this.store.getOwned(artifactId, owner);
  }

  /**
   * 打开快照字节流。返回一个异步迭代器，调用方直接转成 HTTP body——
   * 不整读进内存，产物可以很大。
   */
  openSnapshot(record: ExecArtifactRecord): AsyncGenerator<Buffer> {
    const dest = artifactBlobPath(this.#roots, record.orgId, record.artifactId);
    return iterSnapshotChunks(dest, record.identity ?? undefined);
  }

  /**
   * 把一个属于调用者的产物导入目标工作区，作为输入文件。
   *
   * 与 submit 相反的方向：控制面 → 工作区。落点同样经 `resolve()` 围栏，
   * 目标名经 `sanitizeFilename`。
   */
  async importToWorkspace(input: {
    artifactId: string;
    workspace: WorkspaceContext;
    owner: OwnerScope;
    targetFilename?: string | null;
  }): Promise<{ record: ExecArtifactRecord; path: string }> {
    try {
      const record = await this.store.getOwned(input.artifactId, input.owner);
      if (!record) {
        throw new ArtifactError('artifact_not_found', 'Artifact not found', 404);
      }
      const wanted = (input.targetFilename ?? '').trim() || record.name;
      const safeName = sanitizeFilename(wanted);
      if (!safeName) {
        throw new ArtifactError('target_filename_invalid', 'target_filename is invalid', 400);
      }

      const fs = this.fsFactory(input.workspace);
      const target = await fs.resolve(safeName);

      // 流式落盘。产物上限 512MiB，整读进内存再写会让一次导入就吃掉半个 G。
      const sink = createWriteStream(target.targetKey);
      await pipeline(this.openSnapshot(record), sink);

      return { record, path: safeName };
    } catch (err) {
      this.#redact(err, input.workspace);
    }
  }
}
