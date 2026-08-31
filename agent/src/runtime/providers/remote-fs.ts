/**
 * `ctx.fs` 的 RPC 代理——本机零文件/进程操作，全部转发 exec 内部面。
 *
 * 为什么不直接复用 `dsh-fs-local`：exec 侧已用它包了围栏与版本，这里是 Agent 侧，
 * 执行世界在另一个容器里（dsh-rebuild 4.2 自建清单第一行）。`resolve()` 异步
 * 也是为此设计——远程后端可能需要 I/O（上游注释原话）。
 *
 * 错误一律经 `toWireError` 无条件脱敏（硬约束 #1），`physicalRoots` 必传无默认值。
 * `streamText` 用 `guardIterable` 二次包，错误在 `for await` 迭代时才抛。
 */

import { FileSystem } from '@deepseek-ai/dsh-fs';
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsVersion,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs';
import type { Context } from '@deepseek-ai/cordis';
import { ContractError } from '@pi/contract/errors.js';
import { ExecRpcClient, guardIterable, resolveExecRpcConfig } from './exec-rpc.js';
import type { ExecRpcConfig } from './exec-rpc.js';

export interface RemoteFileSystemOptions extends ExecRpcConfig {}

export class RemoteFileSystem extends FileSystem {
  private readonly rpc: ExecRpcClient;

  constructor(ctx: Context, options: Partial<RemoteFileSystemOptions> = {}) {
    super(ctx as unknown as never);
    const resolved = resolveExecRpcConfig(options);
    this.rpc = new ExecRpcClient(resolved);
  }

  rebind(options: ExecRpcConfig): void {
    this.rpc.rebind(options);
  }

  /**
   * 脱敏用的物理根，**每次调用时从本 Run 的 ALS 取**（ADR 0009 D3）。
   *
   * 2026-08-31 之前这是一个字段，由 `rebind()` 按 Run 改写。而 provider 是
   * 全进程共享的单例（`ensureCtx` 是 `bootOnce`），所以并发的第二个 Run 会把
   * 第一个 Run 的脱敏根换掉——A 的未分类错误按 B 的根脱敏 = A 的真实路径原样泄漏。
   * 见 `tests/runtime/tenant-isolation.test.ts`。
   */
  private get roots(): readonly string[] {
    return this.rpc.activeConfig().physicalRoots;
  }

  /** 围栏在 exec 侧；Agent 进程不宣称本机 sandbox，避免工具层强依赖 sandboxPolicy。 */
  override get sandboxMode(): 'workspace-write' | undefined {
    return undefined;
  }

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    if (opts?.signal?.aborted === true) throw new ContractError('INTERNAL_ERROR', 'aborted');
    const payload: Record<string, unknown> = { path };
    if (opts?.cwd !== undefined) payload['cwd'] = opts.cwd;
    return this.rpc.post<Record<string, unknown>, FsTarget>('/internal/v1/fs/resolve', payload, this.roots);
  }

  override processPath(target: FsTarget): string {
    // 远程世界的“可给子进程打开的绝对路径”即 displayPath 本身（exec 侧已算好）
    return target.displayPath;
  }

  override fileUrl(target: FsTarget): string {
    const encoded = encodeURI(target.displayPath);
    return `file://${encoded}`;
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    // 远程 containment 由 exec 侧 `WorkspaceFileSystem.contains` 定权威；此处做本地前缀近似，
    // 仅用于 DSH 工具层的快速预检，不替代服务端围栏。
    const p = parent.targetKey as unknown as string;
    const c = child.targetKey as unknown as string;
    return c === p || c.startsWith(p.endsWith('/') ? p : `${p}/`);
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    if (signal?.aborted === true) throw new ContractError('INTERNAL_ERROR', 'aborted');
    const data = await this.rpc.post<{ target: FsTarget }, FsInfo | null>(
      '/internal/v1/fs/stat',
      { target },
      this.roots,
    );
    return data ?? undefined;
  }

  override async lstat(
    path: string,
    opts?: { cwd?: string },
    signal?: AbortSignal,
  ): Promise<FsPathInfo | undefined> {
    if (signal?.aborted === true) throw new ContractError('INTERNAL_ERROR', 'aborted');
    const payload: Record<string, unknown> = { path };
    if (opts?.cwd !== undefined) payload['cwd'] = opts.cwd;
    const data = await this.rpc.post<Record<string, unknown>, FsPathInfo | null>(
      '/internal/v1/fs/lstat',
      payload,
      this.roots,
    );
    return data ?? undefined;
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted === true) throw new ContractError('INTERNAL_ERROR', 'aborted');
    const data = await this.rpc.post<{ target: FsTarget }, { text: string }>(
      '/internal/v1/fs/read-text',
      { target },
      this.roots,
    );
    return data.text;
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    if (signal?.aborted === true) throw new ContractError('INTERNAL_ERROR', 'aborted');
    const query: Record<string, string> = {
      target: Buffer.from(JSON.stringify(target), 'utf8').toString('base64url'),
    };
    const iterable = await this.rpc.getStream('/internal/v1/fs/stream-text', query, this.roots);
    // 二次包：exec 侧已脱敏一次，这里再经 guardIterable 兜底
    return guardIterable(iterable, this.roots);
  }

  override async readBytes(
    target: FsTarget,
    signal: AbortSignal | undefined,
    maxBytes: number,
  ): Promise<Uint8Array> {
    if (signal?.aborted === true) throw new ContractError('INTERNAL_ERROR', 'aborted');
    const data = await this.rpc.post<{ target: FsTarget; maxBytes: number }, { bytes: string }>(
      '/internal/v1/fs/read-bytes',
      { target, maxBytes },
      this.roots,
    );
    return Buffer.from(data.bytes, 'base64');
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    if (signal?.aborted === true) throw new ContractError('INTERNAL_ERROR', 'aborted');
    const data = await this.rpc.post<{ target: FsTarget }, FsDirEntry[]>(
      '/internal/v1/fs/list',
      { target },
      this.roots,
    );
    return data;
  }

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
  ): Promise<FsWriteOutcome> {
    if (signal?.aborted === true) throw new ContractError('INTERNAL_ERROR', 'aborted');
    const payload: Record<string, unknown> = { target, content };
    if (expected !== undefined) payload['expected'] = expected;
    return this.rpc.post<Record<string, unknown>, FsWriteOutcome>(
      '/internal/v1/fs/write-text',
      payload,
      this.roots,
    );
  }

  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
  ): Promise<FsEditOutcome> {
    if (signal?.aborted === true) throw new ContractError('INTERNAL_ERROR', 'aborted');
    const payload: Record<string, unknown> = { target, edit };
    if (expected !== undefined) payload['version'] = expected.version;
    return this.rpc.post<Record<string, unknown>, FsEditOutcome>(
      '/internal/v1/fs/edit-text',
      payload,
      this.roots,
    );
  }
}

export default RemoteFileSystem;
