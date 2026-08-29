/**
 * 会话私有、跨 Run 持久的 `/tmp` 物理树（ADR 0004）——只管这一件事：给定一个
 * `workspace_id`，算出并初始化它配对的 temp 物理根
 * `tempBaseRoot/tmp_{workspace_id}`。
 *
 * **语义一字不改**（ADR 0004 是硬约束）：
 * - 这不是每次执行独立的 tmpfs，是随 AgentSession 生命周期持久化的目录。
 * - 权限 `0700`——只有运行 exec 服务的用户能看到这棵树的元数据。
 * - XDG 三个子目录（`.config`/`.cache`/`.local/share`）**不在这个文件里创建**：
 *   `exec/src/isolation/build.ts` 已经把它们建模成 `MountPlan` 里
 *   `ensureDir: true` 的 `Mount`（源固定是 `${tempRoot}/.home/...`），运行时
 *   由 `exec/src/isolation/bubblewrap.ts` 的 `resolveEffectiveMounts()` 在
 *   spawn 前负责 `mkdir`。这条 ADR 0004 D9 的行为已经被 W1-C 落实，本文件
 *   不重复实现——两边各建一遍目录只会制造"谁的 mkdir 先跑"的竞态。这里只要
 *   保证 `tempRoot` 本身存在，`.home/` 是它天然的子目录，跟着它的生命周期与
 *   配额走，不构成第四个存储根。
 *
 * 由 `lifecycle.ts` 调用；不单独导出到 `exec/src/workspace/` 之外。
 */
import { chmod, mkdir } from 'node:fs/promises';
import { joinContained, tempIdForWorkspaceId, validateOpaqueId } from './ids.js';

/** 目录权限：与 Python 版 `temp.chmod(0o700)` 一致——仅 owner 可读写执行。 */
const TEMP_TREE_MODE = 0o700;

/** 给定 temp 基础根与 workspace_id，算出这个会话配对的 temp 物理根路径。
 * 不做任何 I/O，纯路径运算，方便在还没有真实磁盘的地方（比如上层构造
 * `WorkspaceContext` 之前）先拿到路径字符串。 */
export function physicalTempPath(tempBaseRoot: string, workspaceId: string): string {
  return joinContained(tempBaseRoot, tempIdForWorkspaceId(workspaceId));
}

/**
 * 创建（幂等）这个会话的持久 temp 根，返回物理路径。
 *
 * 与 Python 版 `init_temp()` 一致：先确保 `tempBaseRoot` 本身存在，再
 * `mkdir(parents=True, exist_ok=True)` 目标目录，最后 `chmod(0o700)`——
 * chmod 失败（比如某些不支持 POSIX 权限位的文件系统）不致命，静默忽略，
 * 因为目录已经创建成功，权限只是纵深防御的一层，不是这个操作能否成立的前提。
 */
export async function initTempTree(tempBaseRoot: string, workspaceId: string): Promise<string> {
  validateOpaqueId(workspaceId, 'workspace_id');
  await mkdir(tempBaseRoot, { recursive: true });
  const tempRoot = physicalTempPath(tempBaseRoot, workspaceId);
  await mkdir(tempRoot, { recursive: true });
  try {
    await chmod(tempRoot, TEMP_TREE_MODE);
  } catch {
    // 见函数注释：不是致命失败。
  }
  return tempRoot;
}
