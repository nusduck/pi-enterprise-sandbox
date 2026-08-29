/**
 * `WorkspaceFileSystem` —— `ctx.fs` 的多租户实现（ADR 0008 D1）。
 *
 * 这是什么：`extends LocalFileSystem`，只覆盖两件事——
 *   1. 租户根解析：把外部传入的逻辑路径（相对路径 / `/home/sandbox/workspace/...`
 *      / `/tmp/...`）映射到"这个会话"的两个物理根（`workspaceRoot`、`tempRoot`），
 *      而不是 `dsh-fs-local` 自带的单一 `config.cwd`。
 *   2. 写入前紧邻的 containment 复查：`writeText`/`editText` 落盘前，用刚刚
 *      realpath 出来的物理路径再确认一次没有跑出这两个根。
 *
 * 为什么这样设计（不是别的做法）：`dsh-fs-local` 已经实现了 12 个基础操作、
 * 文件版本、原子写、`createIfAbsent` 的抢占语义、`editText` 的加锁临界区、
 * 全套 `FS_*` 错误码——这些都不重新实现，见 `exec/node_modules/@deepseek-ai/
 * dsh-fs-local/README.md`。它自己写明的限制是"`config.cwd` 不是沙箱"，
 * 我们补的正是这个洞。上游同类做法是 `dsh-fs-sandbox`（`extends LocalFileSystem`
 * 再加模式围栏），我们是同一个思路，只是围栏规则从 Python 版
 * `sandbox/security/path_validation.py` 移植（见 `./path-policy.ts`）。
 *
 * 额外做的一件事（严格说超出"只覆盖两件事"，但是硬要求）：所有 12 个基础操作
 * 都包了一层 `guard()`，在错误消息离开这一层之前做物理路径脱敏
 * （ADR 0008 验证要求 #7）。原因写在 `guard()` 的注释里——`dsh-fs-local` 的
 * `FS_IO_ERROR`/`FS_PERMISSION_DENIED` 消息会原样拼接 Node 底层 `error.message`，
 * 那段文本天然带物理路径，不是我们自己拼的，所以不脱敏就会泄漏。这些覆盖
 * 全部是"调 super 再脱敏"的单行委托，没有重新实现任何一条基础操作的逻辑。
 */
import type { Context } from '@deepseek-ai/cordis';
import {
  FsError,
  FsTargetKey,
  type FsDirEntry,
  type FsEditOutcome,
  type FsEditRequest,
  type FsInfo,
  type FsPathInfo,
  type FsTarget,
  type FsVersion,
  type FsWriteIntent,
  type FsWriteOutcome,
} from '@deepseek-ai/dsh-fs';
import { LocalFileSystem, type Config as LocalFileSystemConfig } from '@deepseek-ai/dsh-fs-local';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { WorkspaceContext } from '../types.js';
import { redactPhysicalRoots } from './redact.js';
import {
  canonicalizePath,
  freshCanonicalTarget,
  isMissingPathError,
  parseSandboxPath,
  toDisplayPath,
} from './path-policy.js';
import { canonicalWritableRoots } from './writable-roots.js';

/** `WorkspaceFileSystem` 自己的构造配置——只暴露 `LocalFileSystem.Config` 里
 * 与租户无关的部分（`diffBasisMaxBytes`）；`cwd` 由租户根决定，不给调用方留口子。 */
export interface WorkspaceFileSystemConfig {
  readonly diffBasisMaxBytes?: number;
}

/** 与 `dsh-fs-local` 内部默认值保持一致（见其 README："Defaults to 10 MiB"）。
 * 我们绕过了 cordis 的 `ctx.plugin()` schema 校验流程直接 `new`，所以要自己
 * 把默认值填好——`LocalFileSystem` 的构造函数要求 `diffBasisMaxBytes` 必须
 * 已经是一个合法数字，不会替我们补默认值。 */
const DEFAULT_DIFF_BASIS_MAX_BYTES = 10 * 1024 * 1024;

export class WorkspaceFileSystem extends LocalFileSystem {
  constructor(
    ctx: Context,
    private readonly workspace: WorkspaceContext,
    config: WorkspaceFileSystemConfig = {},
  ) {
    const resolved: LocalFileSystemConfig = {
      // dsh-fs-local 未覆盖的方法（stat/readText/... 见下）从不读这个字段——
      // 它们只操作已解析好的 FsTarget。真正会被用到的只有 resolve()/lstat()，
      // 而我们两个都整体覆盖、总是显式传物理根，所以这里填什么都不影响行为；
      // 填 workspaceRoot 只是让"万一有人直接读 this.config.cwd"时看到的是一个
      // 有意义的值，而不是服务器进程自己的 cwd。
      cwd: workspace.workspaceRoot,
      diffBasisMaxBytes: config.diffBasisMaxBytes ?? DEFAULT_DIFF_BASIS_MAX_BYTES,
    };
    super(ctx, resolved);
  }

  /** 本类型出厂即处于 workspace-write 模式——多租户根围栏本身就是"沙箱"效果。
   * `read-only` 的区分是隔离层（bwrap 挂载计划）的职责，
   * 不是这一层的；这个 getter 只是如实上报，供工具层展示用。 */
  override get sandboxMode() {
    return 'workspace-write' as const;
  }

  // ── 租户根解析 ──────────────────────────────────────────────────────

  override async resolve(
    rawPath: string,
    opts?: { cwd?: string; signal?: AbortSignal },
  ): Promise<FsTarget> {
    return this.guard(async () => {
      const cwdParsed = opts?.cwd !== undefined ? parseSandboxPath(opts.cwd) : undefined;
      const parsed = parseSandboxPath(rawPath, cwdParsed);
      const physicalRoot = this.physicalRootFor(parsed.scope);

      const target = await super.resolve(parsed.relative, {
        cwd: physicalRoot,
        ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
      });

      // 写入前紧邻复查的姊妹动作：resolve 完成后立刻确认结果没有跑出租户根。
      // parseSandboxPath 已经挡掉了 `..`、其它绝对根等字面越界，但
      // dsh-fs-local 的 realpath 跟随符号链接可能把"看起来合法"的相对路径
      // 解析到根外——这里就是 ADR 0008 D1 说的"符号链接解析后的越界检查"。
      const roots = await canonicalWritableRoots(this.workspace, 'workspace-write');
      if (!this.isWithinAny(roots, target.targetKey)) {
        throw new FsError(
          `path escape detected: ${rawPath} resolves outside workspace`,
          'FS_SANDBOX_DENIED',
        );
      }

      return {
        targetKey: target.targetKey,
        // displayPath 是模型/UI 可见的那一份，必须是逻辑路径，不能是物理路径——
        // dsh-fs-local 自己的 resolve() 会把它设成绝对物理路径（README 原话：
        // "displayPath is the absolute (un-resolved) path"），这里整体替换掉。
        displayPath: toDisplayPath(parsed),
      };
    });
  }

  override async lstat(
    rawPath: string,
    opts?: { cwd?: string },
    signal?: AbortSignal,
  ): Promise<FsPathInfo | undefined> {
    return this.guard(async () => {
      const cwdParsed = opts?.cwd !== undefined ? parseSandboxPath(opts.cwd) : undefined;
      const parsed = parseSandboxPath(rawPath, cwdParsed);
      const physicalRoot = this.physicalRootFor(parsed.scope);
      const physical = path.resolve(physicalRoot, parsed.relative);

      // lstat 按契约不跟随路径最后一段的符号链接，但路径中间的目录段仍然可能
      // 是符号链接——必须先把"到父目录为止"的部分 realpath 一次确认没有越权，
      // 再对最后一段做真正的 lstat。这是补的新用例（ADR 0008 验证要求 #6）：
      // 旧 Python 版没有 lstat 这个概念，围栏规则要在这里重新验证一遍。
      const dir = path.dirname(physical);
      const base = path.basename(physical);

      let realDir: string;
      try {
        realDir = await realpath(dir);
      } catch (err) {
        if (isMissingPathError(err)) return undefined;
        throw err;
      }

      const reconstructed = path.join(realDir, base);
      const roots = await canonicalWritableRoots(this.workspace, 'workspace-write');
      if (!this.isWithinAny(roots, reconstructed)) {
        throw new FsError(
          `path escape detected: ${rawPath} resolves outside workspace`,
          'FS_SANDBOX_DENIED',
        );
      }

      return super.lstat(reconstructed, {}, signal);
    });
  }

  // ── 写入前紧邻的 containment 复查 ──────────────────────────────────

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
  ): Promise<FsWriteOutcome> {
    return this.guard(async () => {
      await this.assertContainedForMutation(target);
      return super.writeText(target, content, expected, signal);
    });
  }

  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
  ): Promise<FsEditOutcome> {
    return this.guard(async () => {
      await this.assertContainedForMutation(target);
      return super.editText(target, edit, expected, signal);
    });
  }

  // ── 其余基础操作：原样委托，只套一层错误脱敏 ──────────────────────
  // 这些方法都只接受已经通过 resolve() 得到的 FsTarget，逻辑一概不动。

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    return this.guard(() => super.stat(target, signal));
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    return this.guard(() => super.readText(target, signal));
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    // `guard()` 只包住了"拿到 iterable"这一步——`dsh-fs-local` 的
    // `streamWholeText()` 是一个 async generator，调用它本身只是同步创建
    // 生成器对象，函数体（包括真正打开文件、读流）要到调用方第一次
    // `for await` 迭代时才会执行。也就是说真正的 I/O 错误（EACCES、文件
    // 被并发删除等，同样是 dsh-fs-local 里"非 abort 就原样 throw error"的
    // 那一类未翻译错误，见 `guard()` 的注释）发生在迭代过程中，完全在
    // 上面这层 `guard()` 的 try/catch 窗口之外——不额外处理的话，这是一个
    // 只有流式读取才会命中的物理路径泄漏缺口。用 `guardIterable()` 把迭代
    // 过程本身也包一层。
    const iterable = await this.guard(() => super.streamText(target, signal));
    return this.guardIterable(iterable);
  }

  /**
   * 把一个异步可迭代对象包成"每次 `next()` 抛出的错误都经过
   * `buildRedactedError()`"的版本。用 `for await...of` 转发而不是手写
   * `next()`/`return()`/`throw()`——这样调用方提前 `break` 时，
   * `for await...of` 的 IteratorClose 语义会自动帮我们把 `return()` 转发给
   * 内层 iterable（也就是 `dsh-fs-local` 那个 `fs.ReadStream`），底层文件
   * 描述符照常被正确关闭，不用我们手动转发三个方法。
   */
  private async *guardIterable<T>(iterable: AsyncIterable<T>): AsyncIterable<T> {
    try {
      for await (const chunk of iterable) {
        yield chunk;
      }
    } catch (err) {
      throw await this.buildRedactedError(err);
    }
  }

  override async readBytes(
    target: FsTarget,
    signal: AbortSignal | undefined,
    maxBytes: number,
  ): Promise<Uint8Array> {
    return this.guard(() => super.readBytes(target, signal, maxBytes));
  }

  /** 兼容数据集/产物层的字节写入——`dsh-fs` 只有 `writeText`，这里把字节按 utf8 转文本后复用同一条原子写路径。 */
  async writeBytes(
    target: FsTarget,
    content: Uint8Array,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
  ): Promise<FsWriteOutcome> {
    const text = Buffer.from(content).toString('utf8');
    return this.writeText(target, text, expected, signal);
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    return this.guard(() => super.listDir(target, signal));
  }

  // ── 内部辅助 ────────────────────────────────────────────────────────

  private physicalRootFor(scope: 'workspace' | 'temp'): string {
    return scope === 'temp' ? this.workspace.tempRoot : this.workspace.workspaceRoot;
  }

  /** 用继承自 `LocalFileSystem` 的 `contains()`（未覆盖，原样复用）判断
   * `candidatePhysical` 是否落在任意一个根内或就是根本身。不重新实现
   * "relative path 前缀比较"这条逻辑，直接借用父类已经测试过的实现。 */
  private isWithinAny(roots: readonly string[], candidatePhysical: string): boolean {
    const child: FsTarget = { targetKey: FsTargetKey(candidatePhysical), displayPath: candidatePhysical };
    return roots.some((root) =>
      this.contains({ targetKey: FsTargetKey(root), displayPath: root }, child),
    );
  }

  private async assertContainedForMutation(target: FsTarget): Promise<void> {
    const fresh = await freshCanonicalTarget(target.targetKey);
    const roots = await canonicalWritableRoots(this.workspace, 'workspace-write');
    if (!this.isWithinAny(roots, fresh)) {
      throw new FsError(
        `refusing to write "${target.displayPath}": target resolves outside workspace`,
        'FS_SANDBOX_DENIED',
      );
    }
  }

  /**
   * 所有对外方法的统一出口：无条件把任何跨越这一层边界的抛出物重建成
   * "消息已脱敏"的版本再抛出。
   *
   * 早期版本这里写的是 `if (err instanceof FsError) { 脱敏 }`，隐含假设
   * "dsh-fs-local 的失败都已经翻译成 FsError"——**这个假设是错的**。实测
   * （制造一个真实 EACCES）发现 `resolveLocalTarget()`（dsh-fs-local 内部，
   * `lib/index.js` 的 `resolveLocalTarget`）在 `realpath()` 抛出非 ENOENT
   * 错误时，直接把裸 Node `Error` 原样朝外抛，从没翻译成 `FsError`：
   *
   *   Error: EACCES: permission denied, realpath '/…/workspace/locked-dir/inner.txt'
   *       at async realpath (node:internal/fs/promises:2014:10)
   *       at async resolveLocalTarget (dsh-fs-local/lib/index.js:159:27)
   *
   * 那条消息是 Node fs 模块自己格式化的，带着完整物理路径，`instanceof
   * FsError` 判断为假，直接绕过了旧版本的脱敏——物理路径原样穿出去。
   * "一个物理根都不许漏"是硬要求，条件式脱敏就是 fail-open：任何一种没
   * 预料到的抛出物类型都会带着物理路径漏出去。改成无条件处理，参照
   * `contract/src/errors.ts` 的 `toWireError()` 分级兜底：
   *
   *   1. `FsError`        → 重建成同 `code` 的 `FsError`，消息脱敏
   *   2. 其它 `Error`      → 按 dsh-fs 契约，`ctx.fs` 的失败本来就应该是
   *      `FsError`（"Failures throw FsError... carrying a stable
   *      FsErrorCode"）——上游这条路径没做到，这里替它做，顺便修好它对
   *      契约的违反：重建成 `FsError(..., 'FS_IO_ERROR', { cause: err })`
   *   3. 非 `Error` 的任意抛出物 → `String()` 兜底取文本，同样脱敏，同样
   *      包成 `FS_IO_ERROR`（没有 `cause`，因为它本身不是 `Error`）
   *
   * 三条路径共用同一份 `redactPhysicalRoots()`，没有能绕过去的分支。
   */
  private async guard<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (err) {
      throw await this.buildRedactedError(err);
    }
  }

  private async buildRedactedError(err: unknown): Promise<FsError> {
    const roots = await this.physicalRootsForRedaction();
    if (err instanceof FsError) {
      return new FsError(
        redactPhysicalRoots(err.message, roots),
        err.code,
        err.cause !== undefined ? { cause: err.cause } : {},
      );
    }
    if (err instanceof Error) {
      return new FsError(redactPhysicalRoots(err.message, roots), 'FS_IO_ERROR', { cause: err });
    }
    return new FsError(redactPhysicalRoots(String(err), roots), 'FS_IO_ERROR');
  }

  /**
   * 脱敏要匹配的物理根列表：配置原文 **和** realpath 之后的规范形式都要
   * 进列表，两种拼写都可能出现在错误文本里——
   *
   * - 我们自己拼的错误消息（`resolve()`/写入前 containment 复查那些）用的
   *   是配置原文（`this.workspace.workspaceRoot` 等，未经 realpath）。
   * - Node fs 模块自己格式化的错误消息（比如上面 `guard()` 注释里那条
   *   EACCES）用的是它实际打开的路径，也就是 realpath 之后那份。
   *
   * macOS 上两者经常不同（`/var` 本身是指向 `/private/var` 的符号链接：
   * 配置根是 `/var/folders/...`，Node 报错里是
   * `/private/var/folders/...`）；生产环境只要工作区根路径上有任何一层
   * 符号链接（软链挂载点很常见）就会有同样的分叉。只登记配置原文会让一半
   * 的错误消息脱敏静默失效——这里两种都登记，不省略任何一种。
   */
  private async physicalRootsForRedaction(): Promise<readonly string[]> {
    const configured = [
      this.workspace.workspaceRoot,
      this.workspace.tempRoot,
      this.workspace.systemSkillRoot,
      ...this.workspace.enabledSkillPackages.map((pkg) => pkg.sourcePath),
    ];
    const canonical = await Promise.all(configured.map((root) => canonicalizePath(root)));
    return [...configured, ...canonical];
  }
}

export default WorkspaceFileSystem;
