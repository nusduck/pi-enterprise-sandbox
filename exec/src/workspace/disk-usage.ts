/**
 * 递归统计一棵物理目录树的字节数——移植自 Python 版
 * `sandbox/services/file_manager.py::workspace_size_bytes()`，配额账本
 * （`quota-ledger.ts`）与子进程配额监控（`child-quota.ts`）共用。
 *
 * 移植时发现的 Python bug（写进主控要的报告，这里也记一笔）：原函数的循环体是
 *
 * ```python
 * if fp.is_file() and not fp.is_symlink():
 *     total += fp.stat().st_size
 * elif fp.is_file():
 *     # Count symlink targets that still live inside the tree
 *     total += fp.stat().st_size
 * ```
 *
 * 两个分支的代码**完全相同**——`is_symlink()` 的判断只是死代码，注释声称
 * "区分符号链接目标"，但两条分支都无条件 `fp.stat().st_size`（`stat()` 本来
 * 就穿透符号链接），实际行为跟没有这个 if/elif 分叉一模一样。这里按它
 * **实际的行为**移植（"任何 `readdir` 报出的文件名，只要 `stat()` 能穿透
 * 到一个正规文件就计入大小"），不移植那段名不副实的注释。
 *
 * 与 Python 版一致的另一条语义：目录的遍历本身不穿透符号链接（`os.walk()`
 * 默认不跟随目录符号链接）——这里用 `Dirent.isDirectory()` 做同样的事，
 * 它对"指向目录的符号链接"返回 `false`，天然不会递归进符号链接目标，
 * 避免了目录环导致的无限递归，也避免了通过符号链接把统计范围带出 `root`。
 */
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

/** 统计 `root` 下所有文件（含指向文件的符号链接，broken symlink 静默跳过）
 * 的字节数之和。`root` 不存在时返回 0——与 Python 版 `if not root.exists()`
 * 的提前返回一致。 */
export async function workspaceSizeBytes(root: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    // 根目录不存在，或者是别的读取失败——都当作空树处理，与 Python 版
    // "不存在返回 0"一致；`stat()` 失败也一样静默跳过（见下方每个 catch）。
    return 0;
  }

  let total = 0;
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      total += await workspaceSizeBytes(full);
      continue;
    }
    // 常规文件、指向文件的符号链接、其它特殊文件——一律尝试 stat()（穿透
    // 符号链接），失败（例如 broken symlink 的 ENOENT）就跳过，不计入也不报错。
    try {
      const st = await stat(full);
      if (st.isFile()) {
        total += st.size;
      }
    } catch {
      continue;
    }
  }
  return total;
}
