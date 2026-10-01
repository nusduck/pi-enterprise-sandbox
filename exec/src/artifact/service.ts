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

import { randomUUID, createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { WorkspaceContext } from '../types.js';
import { redactPhysicalRoots } from '../fs/redact.js';
import type { WorkspaceFileSystem } from '../fs/workspace-fs.js';
import { sanitizeFilename } from '../attachment/sanitize.js';
import type {
  ArtifactCreatedByKind,
  ArtifactStore,
  ArtifactVisibility,
  ArtifactVisibilityUpdate,
  ExecArtifactRecord,
  OwnerListQuery,
  OwnerScope,
} from '../db/repositories/artifacts.js';
import { InMemoryArtifactStore } from '../db/repositories/artifacts.js';
import {
  InMemoryWorkspacePolicyStore,
  type WorkspacePolicyStore,
} from '../db/repositories/workspace-policies.js';
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

/**
 * 规范化平台生成的逻辑路径：逐段清洗文件名，丢掉空段与 `.`。
 *
 * `..` 不在这里拦——交给 `fs.resolve()` 的 path-policy 围栏统一判（一处判定比
 * 两处更不容易漂移）。返回 `null` 表示没有任何可用段。
 */
function normalizeLogicalPath(raw: string): string | null {
  const segments = String(raw ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '' && segment !== '.')
    .map((segment) => (segment === '..' ? '..' : sanitizeFilename(segment)));
  if (segments.length === 0) return null;
  if (segments.some((segment) => segment === '')) return null;
  return segments.join('/');
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
  /**
   * 显式指定可见性。审核面的两个调用方必须用它：
   * - 材料快照恒为 `withdrawn`（永远不对发起人可见，只供审核员读取）；
   * - 审核员的修订版恒为 `held`（要等这次审核通过才放行）。
   *
   * 省略时按**工作区策略**判定：review 工作区写 `held`，其余写 `released`
   * （design §3.2「review 工作区里提交的产物一律写为 held」）。
   */
  readonly visibility?: ArtifactVisibility | null;
  /** 修订版指向被替换的那一版；原件永不覆盖。 */
  readonly revisionOf?: string | null;
  readonly createdByKind?: ArtifactCreatedByKind | null;
}

export interface ArtifactServiceOptions {
  readonly roots?: ControlPlaneRoots;
  readonly maxBytes?: number;
  readonly quotaLedger?: WorkspaceQuotaLedger;
  /**
   * 工作区交付策略（ADR 0016 D1）。省略 = 没有工作区需要审核（单测/本地装配）；
   * `createExecApp` 总会给一个（生产是 MySQL 实现）。
   */
  readonly workspacePolicies?: WorkspacePolicyStore;
}

export class ArtifactService {
  readonly #roots: ControlPlaneRoots;
  readonly #maxBytes: number;
  readonly #quotaLedger: WorkspaceQuotaLedger;
  readonly #workspacePolicies: WorkspacePolicyStore;

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
    this.#workspacePolicies =
      options.workspacePolicies ?? new InMemoryWorkspacePolicyStore();
  }

  /**
   * 这一版产物该有多可见。
   *
   * 显式指定优先（快照恒 `withdrawn`、修订恒 `held`）；否则看工作区策略：
   * review 工作区一律 `held`，其余 `released`（design §3.2）。
   *
   * **策略读取失败必须抛**，不能当作 direct：把一次数据库抖动变成「待审产物
   * 直接交付」正是这个功能最不能出的错（AGENTS.md §2 fail-closed）。
   */
  async #resolveVisibility(req: ArtifactSubmitRequest): Promise<ArtifactVisibility> {
    if (req.visibility) return req.visibility;
    const delivery = await this.#workspacePolicies.deliveryOf(req.workspace.workspaceId);
    return delivery === 'review' ? 'held' : 'released';
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
      visibility: await this.#resolveVisibility(req),
      revisionOf: req.revisionOf ?? null,
      createdByKind: req.createdByKind ?? 'agent',
    });

    const got = await this.store.getOwned(artifactId, req.owner);
    if (!got) throw new ArtifactError('artifact_not_found', 'artifact insert not visible', 500);
    return got;
  }

  async list(sessionId: string, owner: OwnerScope): Promise<ExecArtifactRecord[]> {
    return await this.store.listBySession(sessionId, owner);
  }

  /**
   * 按工作区列举——公共面的列表走这条。
   *
   * `session_id` 列不是稳定的列表键：内部面的 `submit_artifact` 写 sandbox
   * session id，MCP facade 写 workspace id。公共面的路径参数解析出来的是
   * workspace，所以按 workspace 查两个写入方都覆盖得到。
   *
   * **只列 `released`**（design §3.3 E1）：待审与撤回的产物对发起人一律不存在。
   */
  async listByWorkspace(
    workspaceId: string,
    owner: OwnerScope,
  ): Promise<ExecArtifactRecord[]> {
    return await this.store.listByWorkspace(workspaceId, owner, ['released']);
  }

  /** 同一 owner 跨会话的全部产物（产物库），新的在前。**只列 `released`**（E3）。 */
  async listByOwner(owner: OwnerScope, q: OwnerListQuery): Promise<ExecArtifactRecord[]> {
    return await this.store.listByOwner(owner, q, ['released']);
  }

  /**
   * 取产物元数据；归属不符返回 null（调用方一律翻成 404，不泄漏存在性）。
   *
   * **不看可见性**：内部面（模型工具、MCP facade）需要拿到自己刚提交的
   * `held` 产物元数据。owner 公共面必须走 `getOwnerVisible`。
   */
  async get(artifactId: string, owner: OwnerScope): Promise<ExecArtifactRecord | null> {
    return await this.store.getOwned(artifactId, owner);
  }

  /**
   * 发起人可见的单件产物：非 `released` 与不存在给同一个 `null`
   * （design §3.3 E2/E4——存在性本身不能泄漏，所以不能 403）。
   */
  async getOwnerVisible(
    artifactId: string,
    owner: OwnerScope,
  ): Promise<ExecArtifactRecord | null> {
    const record = await this.store.getOwned(artifactId, owner);
    return record !== null && record.visibility === 'released' ? record : null;
  }

  /**
   * 审核面按 id 取产物：**org 作用域，不看可见性**。
   *
   * 审核员不是发起人，拿不到 owner 作用域；「这件产物属于本任务、属于本 org」
   * 由 agent 的审核账本判定，exec 只保证不跨 org。
   */
  async getInOrg(artifactId: string, orgId: string): Promise<ExecArtifactRecord | null> {
    return await this.store.getInOrg(artifactId, orgId);
  }

  /** 一组产物的状态变更（held → released | withdrawn），单事务、幂等。 */
  async applyVisibilities(
    orgId: string,
    updates: readonly ArtifactVisibilityUpdate[],
  ): Promise<number> {
    return await this.store.applyVisibilities(orgId, updates);
  }

  /**
   * 审核员的修订上传：**新建**一版产物，`revision_of` 指向被替换的那一版。
   * 原件永不覆盖（design §5.1）——审核历史就是这条链。
   *
   * 字节直接落控制面，不走工作区：审核员不进发起人的工作区（design §6.1），
   * 而 TT 唯一的围栏是 `validateSegment` + 控制面根，与 `submit` 共用同一处存储。
   *
   * 记账的边界（有意为之，不是遗漏）：修订版**不占发起人的工作区配额**。配额是
   * 「这个工作区里的字节」的账，而修订版在控制面、属于审核流程；把它记到发起人
   * 头上等于让一次评审消耗被评审者的额度。它仍然受 `maxBytes` 单件上限约束。
   *
   * @throws ArtifactError 原件不存在（404）、超限（413）、名字非法（400）
   */
  async submitRevision(input: {
    readonly originalArtifactId: string;
    readonly orgId: string;
    readonly name?: string | null;
    readonly mimeType?: string | null;
    readonly bytes: Uint8Array;
  }): Promise<ExecArtifactRecord> {
    const original = await this.store.getInOrg(input.originalArtifactId, input.orgId);
    if (original === null) {
      throw new ArtifactError('artifact_not_found', 'Artifact not found', 404);
    }
    if (input.bytes.byteLength > this.#maxBytes) {
      throw new ArtifactError('artifact_too_large', 'artifact exceeds the size limit', 413);
    }
    const displayName = (input.name ?? '').trim() || original.name;
    const safeName = sanitizeFilename(displayName);
    if (!safeName) throw new ArtifactError('artifact_bad_name', 'artifact name is invalid', 400);

    const artifactId = `art_${randomUUID().replace(/-/g, '')}`;
    const dest = artifactBlobPath(this.#roots, input.orgId, artifactId);
    await mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
    // 0600：控制面快照只有 exec 进程可读，与 `streamCopyHashToControl` 一致。
    await writeFile(dest, input.bytes, { mode: 0o600 });
    const digest = createHash('sha256').update(input.bytes).digest('hex');
    const st = await stat(dest, { bigint: true });

    await this.store.insert({
      artifactId,
      // 修订版继承原件的位置信息：它属于同一个会话/工作区，只是内容由审核员给出。
      sessionId: original.sessionId,
      workspaceId: original.workspaceId,
      orgId: original.orgId,
      userId: original.userId,
      name: displayName,
      sourcePath: original.sourcePath,
      mimeType: (input.mimeType ?? '').trim() || original.mimeType,
      sha256: digest,
      sizeBytes: input.bytes.byteLength,
      identity: {
        dev: Number(st.dev),
        ino: Number(st.ino),
        size: Number(st.size),
        mtimeNs: String(st.mtimeNs),
        nlink: Number(st.nlink),
        sha256: digest,
      },
      // 修订版恒 `held`：它是这次审核的候选版本，要等审核通过才放行。
      visibility: 'held',
      revisionOf: original.artifactId,
      createdByKind: 'reviewer',
    });

    const got = await this.store.getInOrg(artifactId, input.orgId);
    if (!got) throw new ArtifactError('artifact_not_found', 'artifact insert not visible', 500);
    return got;
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
   * 把审核员修订后的版本**导入发起人工作区**（design `agent-output-review.md`
   * §5.3 第 3 步）。
   *
   * 与 `importToWorkspace` 的三点不同，都是审核流程要的语义：
   *
   * - 取件用 `getInOrg`（org 作用域、**不看可见性**）：修订版在放行前是 `held`，
   *   而它必须在放行的那一刻就出现在工作区里，好让模型基于审核员改过的版本继续
   *   修改（§5.4）。用 `getOwnerVisible` 会在这里 404。
   * - 目标是**逻辑路径**（`审核版/<name>`），不是文件名：这是平台自己生成的目录，
   *   不是发起人挑的落点，所以允许建子目录。
   * - 路径仍然过 `fs.resolve()` 围栏与逐段文件名清洗，越界一样抛错。
   */
  async importRevisionToWorkspace(input: {
    readonly artifactId: string;
    readonly orgId: string;
    readonly workspace: WorkspaceContext;
    readonly targetPath: string;
  }): Promise<{ record: ExecArtifactRecord; path: string }> {
    try {
      const record = await this.store.getInOrg(input.artifactId, input.orgId);
      if (!record) throw new ArtifactError('artifact_not_found', 'Artifact not found', 404);

      const logical = normalizeLogicalPath(input.targetPath);
      if (!logical) {
        throw new ArtifactError('target_filename_invalid', 'target path is invalid', 400);
      }

      const fs = this.fsFactory(input.workspace);
      // `resolve` 走 path-policy 围栏：绝对路径、`..`、越出工作区根都会在这里被拒。
      const target = await fs.resolve(logical);

      // 工作区根必须已由控制面建好（与 `importToWorkspace` 同一条纪律），但
      // `审核版/` 这一层是平台自己的落点，允许补建。
      const workspaceRoot = input.workspace.workspaceRoot;
      const rootStat = await stat(workspaceRoot).catch(() => null);
      if (!rootStat?.isDirectory()) {
        throw new ArtifactError('artifact_not_found', 'Artifact not found', 404);
      }
      await mkdir(path.dirname(target.targetKey), { recursive: true });

      const sink = createWriteStream(target.targetKey);
      await pipeline(this.openSnapshot(record), sink);

      return { record, path: logical };
    } catch (err) {
      this.#redact(err, input.workspace);
    }
  }

  /**
   * 把一个属于调用者的**已放行**产物导入目标工作区，作为输入文件。
   *
   * `getOwnerVisible`：导入也是发起人拿产物的一条路（design §3.3 E4），
   * 待审/撤回的产物在这里与不存在同一个 404。
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
      const record = await this.getOwnerVisible(input.artifactId, input.owner);
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

      // 工作区根必须已经由控制面建好。这里**不 mkdir -p**：`requireOwnedSession`
      // 只校验 workspaceId 的形状、不查存在性，补建目录等于让任何形状合法的 id
      // 凭一次导入把工作区凭空造出来，也会掩盖"路径参数传错了"这类 bug
      // （2026-09-03 就是拿 sandbox session id 当 workspace 用，靠这条 mkdir 撑住的）。
      const workspaceRoot = path.dirname(target.targetKey);
      const rootStat = await stat(workspaceRoot).catch(() => null);
      if (!rootStat?.isDirectory()) {
        throw new ArtifactError('artifact_not_found', 'Artifact not found', 404);
      }

      // 流式落盘。产物上限 512MiB，整读进内存再写会让一次导入就吃掉半个 G。
      const sink = createWriteStream(target.targetKey);
      await pipeline(this.openSnapshot(record), sink);

      return { record, path: safeName };
    } catch (err) {
      this.#redact(err, input.workspace);
    }
  }
}
