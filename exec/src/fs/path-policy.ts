/**
 * 逻辑路径解析与围栏规则——从 Python 版 `sandbox/security/path_validation.py`
 * 的 `parse_sandbox_path` / `resolve_safe_path` 移植过来的纯函数部分。
 *
 * 背景：`dsh-fs-local` 的 `resolve()` 只把相对路径解析到一个固定的 `cwd`，
 * 绝对路径和 `..` 完全不受它管（这是它 README 里写明的限制，不是 bug）。
 * 我们的租户模型需要"同一份逻辑路径空间"同时覆盖两个物理根——会话工作区
 * 和会话私有 `/tmp`——所以在真正调用 `dsh-fs-local` 之前，必须先把外部传
 * 进来的路径字符串归一化成"选中哪个根 + 根内的相对路径"这一对值。
 *
 * 这个文件不碰任何 dsh-fs 的 Service/Context 机制，纯字符串与文件系统元数据
 * 处理，方便单独做单元测试（同时也是 `workspace-fs.ts` 唯一依赖的路径逻辑）。
 */
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { FsError } from '@deepseek-ai/dsh-fs';

/** 面向模型/客户端的逻辑工作区根——历史上 Python 版叫这个名字，沿用以保持公开契约不变。 */
export const AGENT_WORKSPACE_PATH = '/home/sandbox/workspace';

/** 面向模型/客户端的逻辑持久 temp 根（ADR 0004）。 */
export const AGENT_TEMP_PATH = '/tmp';

/** 一条逻辑路径落在哪个物理根里。 */
export type SandboxPathScope = 'workspace' | 'temp';

/** 解析后的逻辑路径：作用域 + 根内相对路径（POSIX 分隔符，`.` 代表根自身）。 */
export interface ParsedSandboxPath {
  readonly scope: SandboxPathScope;
  readonly relative: string;
}

/** 统一走 `FS_SANDBOX_DENIED`：这是 dsh-fs 错误分类表里专为"围栏拒绝"预留的码，
 * 语义上就是"沙箱拒绝"，不需要我们发明新的错误码。 */
function denied(message: string): FsError {
  return new FsError(message, 'FS_SANDBOX_DENIED');
}

function splitSegments(relative: string): string[] {
  return relative.split('/').filter((seg) => seg.length > 0 && seg !== '.');
}

function rejectTraversal(segments: readonly string[], raw: string): void {
  if (segments.includes('..')) {
    throw denied(`path escape detected: parent traversal: ${raw}`);
  }
}

/**
 * 把一条外部传入的路径字符串解析成 (scope, relative)。
 *
 * 接受：
 * - 相对路径（`foo/bar.txt`、`.`、`./x`）——落在 `cwd` 给出的作用域下（默认工作区根）
 * - `/home/sandbox/workspace/...` 这个逻辑工作区绝对路径
 * - `/tmp/...` 这个逻辑持久 temp 绝对路径
 *
 * 拒绝（逐条对应 Python 版 `parse_sandbox_path` 的拒绝规则）：
 * - 空字节
 * - `~` home 展开
 * - 盘符（Windows 风格 `C:\...`）
 * - 其它任何绝对路径
 * - `..` 父目录穿越（在任何一段里出现即拒绝，不做"净位移"折叠——见下方说明）
 *
 * 关于 `cwd`：Python 版从没有"当前目录"概念，永远相对工作区根解析。dsh-fs 的
 * 契约里 `resolve()`/`lstat()` 都带一个可选 `opts.cwd`（给"会话当前目录"场景用），
 * 我们按同样的围栏规则处理 `cwd` 本身（它也可能是恶意输入），再把校验过的
 * `cwd` 段落拼在相对路径前面。拼接后不会再对"合并后的路径"重新判断 `..`——
 * 因为 `raw` 自身的每一段已经在拼接前单独校验过不含 `..`，所以合并结果里也
 * 不会出现 `..`，无需二次检查（也避免了"cwd 段 + 用户段"哪个负责检查的歧义）。
 */
export function parseSandboxPath(userPath: string, cwd?: ParsedSandboxPath): ParsedSandboxPath {
  if (typeof userPath !== 'string') {
    throw denied('invalid path');
  }
  if (userPath.includes('\0')) {
    throw denied('invalid path: null byte');
  }

  const raw = userPath.trim() || '.';

  if (raw.startsWith('~')) {
    throw denied('invalid path: home expansion not allowed');
  }
  // Windows 盘符：第二个字符是冒号（`C:\x`、`C:/x`）。
  if (raw.length > 1 && raw[1] === ':') {
    throw denied(`path escape detected: absolute path outside workspace: ${raw}`);
  }

  if (raw === AGENT_WORKSPACE_PATH) {
    return { scope: 'workspace', relative: '.' };
  }
  if (raw.startsWith(`${AGENT_WORKSPACE_PATH}/`)) {
    const segments = splitSegments(raw.slice(AGENT_WORKSPACE_PATH.length + 1));
    rejectTraversal(segments, raw);
    return { scope: 'workspace', relative: segments.length ? segments.join('/') : '.' };
  }
  if (raw === AGENT_TEMP_PATH) {
    return { scope: 'temp', relative: '.' };
  }
  if (raw.startsWith(`${AGENT_TEMP_PATH}/`)) {
    const segments = splitSegments(raw.slice(AGENT_TEMP_PATH.length + 1));
    rejectTraversal(segments, raw);
    return { scope: 'temp', relative: segments.length ? segments.join('/') : '.' };
  }
  if (raw.startsWith('/')) {
    throw denied(`path escape detected: absolute path outside sandbox roots: ${raw}`);
  }

  // 纯相对路径：分段校验后拼在 cwd（默认工作区根）之后。
  const segments = splitSegments(raw);
  rejectTraversal(segments, raw);
  const base = cwd ?? { scope: 'workspace' as const, relative: '.' };
  const baseSegments = base.relative === '.' ? [] : base.relative.split('/');
  const combined = [...baseSegments, ...segments];
  return { scope: base.scope, relative: combined.length ? combined.join('/') : '.' };
}

/**
 * 把解析后的逻辑路径转回"面向模型/客户端"的展示形式，与 Python 版
 * `SandboxPath.as_public()` 一致：工作区根内是纯相对路径（根自身是 `.`），
 * temp 根内是 `/tmp/...` 绝对形式。物理路径永远不出现在这里。
 */
export function toDisplayPath(parsed: ParsedSandboxPath): string {
  if (parsed.scope === 'temp') {
    return parsed.relative === '.' ? AGENT_TEMP_PATH : `${AGENT_TEMP_PATH}/${parsed.relative}`;
  }
  return parsed.relative;
}

/**
 * realpath 一个物理根，解析失败（根还不存在等）时原样返回而不是抛错——
 * 保守选择：一个不存在的根不会被误判为"包含"任何路径，比编造一个后备值更安全。
 * 与上游 `@deepseek-ai/dsh-sandbox` 的 `canonicalPath` 同一思路（该函数是同步版，
 * 这里用异步 `fs/promises` 是因为整条调用链都是 async）。
 */
export async function canonicalizePath(root: string): Promise<string> {
  try {
    return await realpath(root);
  } catch {
    return root;
  }
}

/**
 * 写入前"紧邻"再规范化一次目标物理路径（ADR 0008 D1 的必须动作）。
 *
 * `target.targetKey` 在 `resolve()` 时已经是 realpath（或者目标不存在时是
 * "已存在祖先的 realpath + 缺失的 basename"）。这里在真正落盘前重新 realpath
 * 一次，覆盖"resolve() 之后、写入之前，路径上的某个祖先被换成了指向工作区
 * 外的符号链接"这类残余竞态的一部分——不消除 TOCTOU（ADR 0008 明确接受这个
 * 残余窗口），只是把校验窗口尽量贴近实际写入动作。
 */
export async function freshCanonicalTarget(targetKey: string): Promise<string> {
  try {
    return await realpath(targetKey);
  } catch {
    // 目标尚不存在是正常情况（比如 createIfAbsent 创建新文件）：改成 realpath
    // 父目录，再拼回 basename，与 dsh-fs-local 自己 resolve 缺失路径时的做法一致。
    const dir = path.dirname(targetKey);
    try {
      const realDir = await realpath(dir);
      return path.join(realDir, path.basename(targetKey));
    } catch {
      // 连父目录都不可达：原样返回，交给上层的围栏检查按"不在根内"处理，
      // 宁可保守拒绝也不要在未知状态下放行。
      return targetKey;
    }
  }
}

/** 判断一个 Node 文件系统错误是不是"路径不存在"这一类（ENOENT/ENOTDIR）。 */
export function isMissingPathError(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err.code === 'ENOENT' || err.code === 'ENOTDIR');
}
