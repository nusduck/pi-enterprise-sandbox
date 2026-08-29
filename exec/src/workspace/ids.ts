/**
 * 工作区标识与物理路径拼接的纯函数——移植自 Python 版 `sandbox/paths.py` 的
 * `temp_id_for_workspace_id()` 与 `sandbox/services/workspace_manager.py` 里
 * `physical_path_for_workspace_id()` / `physical_temp_path_for_workspace_id()`
 * 的路径拼接 + containment 校验部分。
 *
 * 为什么单独一个文件：这里的每个函数都会被 `lifecycle.ts`、`temp-tree.ts`、
 * `quota-ledger.ts`、`child-quota.ts` 共用，纯字符串/路径运算，没有任何 I/O，
 * 方便独立做单元测试，也避免"每个文件各自拼一遍工作区目录名"。
 *
 * `workspaceId` 校验策略与 Python 版的差异（写进报告，不是我自己拍板改的）：
 * Python 版 `init_workspace()` 用 `validate_formal_id()` 强制 26 位 Crockford
 * Base32 ULID；但同一个仓库里 `remove_workspace()` 又显式为"legacy/internal
 * non-formal ids（比如旧 `sandbox_*` 私有树）"留了一条回退校验（只要求不含
 * 路径分隔符与 `..`）——也就是说 Python 自己的生产代码已经承认 workspace_id
 * 不总是 ULID 形态。`types.ts` 的 `WorkspaceContext.workspaceId` 注释只说
 * "对外唯一暴露的不透明标识"，没有钦定编码，主控也没有在 §5.1/§5.4 里把
 * ULID 格式列为契约。因此这里只做"不透明安全 token"这一条通用校验（长度、
 * 字符集、不含路径分隔符），不强制 ULID——比 Python 的创建路径更宽松、比它
 * 的删除路径更严格。如果主控认为 workspace_id 必须是 ULID，这条要在
 * `contract/` 或 `types.ts` 的文档里明确下来，我不在这里替主控做这个决定。
 */
import path from 'node:path';

/** workspace_id 是否是"不透明安全 token"：非空、不超过 128 字节、只含
 * ASCII 字母数字与 `-`/`_`。刻意不接受任何路径分隔符或 `.`/`..`——
 * 一旦允许，`joinContained()` 的 containment 检查是最后一道防线，
 * 但这道校验应该在此之前就把畸形输入挡掉，两层防御不算重复。 */
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export class InvalidWorkspaceIdError extends Error {
  override readonly name = 'InvalidWorkspaceIdError';
}

/** 校验并原样返回一个不透明 id（workspace_id / reservation_id 共用同一条规则）。 */
export function validateOpaqueId(value: string, field: string): string {
  if (typeof value !== 'string' || !SAFE_ID_RE.test(value)) {
    throw new InvalidWorkspaceIdError(
      `invalid ${field}: expected 1..128 opaque ASCII characters ([A-Za-z0-9_-])`,
    );
  }
  return value;
}

/** 与 workspace_id 配对的持久 temp 目录标识（ADR 0004）。与 Python 版
 * `temp_id_for_workspace_id()` 同一命名规则，`tmp_` 前缀。 */
export function tempIdForWorkspaceId(workspaceId: string): string {
  validateOpaqueId(workspaceId, 'workspace_id');
  return `tmp_${workspaceId}`;
}

export class PathEscapeError extends Error {
  override readonly name = 'PathEscapeError';
}

/**
 * 把 `root` 与 `childId`（已校验过的不透明 id）拼成一个物理子路径，并确认
 * 拼接结果确实落在 `root` 之内——对应 Python 版每个 `init_*`/`remove_*` 里
 * 重复出现的 `resolve()` + `is_relative_to()` 检查。
 *
 * 用 `path.resolve()` 而不是 `fs.realpath()`：这一步只是防"字符串拼接" 层面
 * 的越界（理论上不该发生，因为 `childId` 已经被 `validateOpaqueId()` 挡掉了
 * 路径分隔符），不依赖目标是否已经在磁盘上存在——与 Python 的
 * `Path.resolve()`（默认 `strict=False`）语义一致。
 */
export function joinContained(root: string, childId: string): string {
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, childId);
  const withSep = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
  if (candidate !== resolvedRoot && !candidate.startsWith(withSep)) {
    throw new PathEscapeError(`refusing to construct a path escaping its root: ${childId}`);
  }
  return candidate;
}
