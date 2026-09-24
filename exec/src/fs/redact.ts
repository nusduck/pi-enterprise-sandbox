/**
 * 物理路径脱敏——移植自 Python 版 `sandbox/paths.py` 的 `sanitize_physical_paths`
 * / `sanitize_path_error`。
 *
 * 为什么需要它：`dsh-fs-local` 的错误消息里，除了我们控制的 `target.displayPath`
 * 之外，还会原样拼进 Node 底层 fs 报错的 `error.message`（例如
 * `EACCES: permission denied, open '/var/data/workspaces/conv_x/notes/a.txt'`）——
 * 这一段是 Node 自己格式化的，天然带物理路径，`WorkspaceFileSystem` 不重新实现
 * 这些错误消息，只能在它们离开这一层之前做一次文本替换。
 *
 * ADR 0008 验证要求 #7："所有 FS_* 错误消息经 redact()，断言无物理根残留"，
 * 这是硬要求，宁可多替换（把一个凑巧出现在合法文件名里的子串也替换掉）也不要
 * 漏掉一个物理根。
 */

/** 物理根被替换成的公开占位符。与 Python 版 `PUBLIC_WORKSPACE_TOKEN` 保持一致。 */
export const REDACTED_ROOT_TOKEN = '<workspace>';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 把 `text` 里出现的任何一个 `physicalRoots` 前缀替换成 `<workspace>`。
 *
 * - 去重、去掉尾部斜杠、按长度降序处理——保证嵌套根（比如 workspaceRoot 是
 *   tempRoot 的父目录这种反常配置）总是先替换更长、更具体的那个，不会被短根
 *   抢先替换出一个不完整的残留片段。
 * - 替换后折叠连续出现的占位符（同一处路径被多个重叠根先后命中时会产生
 *   `<workspace><workspace>` 这种重复，折叠成一个）。
 */
export function redactPhysicalRoots(text: string, physicalRoots: readonly string[]): string {
  if (!text) return text;

  const unique = Array.from(
    new Set(
      physicalRoots
        .map((root) => root.replace(/\/+$/, ''))
        .filter((root) => root.length > 0),
    ),
  );
  unique.sort((a, b) => b.length - a.length);

  let sanitized = text;
  for (const root of unique) {
    if (sanitized.includes(root)) {
      sanitized = sanitized.split(root).join(REDACTED_ROOT_TOKEN);
    }
  }

  const collapse = new RegExp(`(?:${escapeRegExp(REDACTED_ROOT_TOKEN)}){2,}`, 'g');
  sanitized = sanitized.replace(collapse, REDACTED_ROOT_TOKEN);

  return sanitized;
}
