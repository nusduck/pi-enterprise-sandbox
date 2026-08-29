/**
 * 工作区生命周期——移植自 Python 版 `sandbox/services/workspace_manager.py`
 * 的 `WorkspaceManager`。
 *
 * 一个 Agent Session 独占一个稳定工作区：同一会话多轮 Run 复用同一个
 * `workspaceId`，物理根固定为 `workspacesBaseRoot/{workspaceId}`，配对的
 * 持久 temp 树见 `temp-tree.ts`（ADR 0004）。
 *
 * **物理根只存在于这一层**：本文件的返回值只在 exec 服务内部流动，绝不
 * 原样进入 API、日志、模型上下文或错误文本——任何可能携带物理路径的错误
 * 消息在离开这个模块之前都经过 `redactPhysicalRoots()`（复用 W1-B 的
 * `fs/redact.ts`），这是硬约束，不是"调用方要求才做"的可选项。
 *
 * 与 Python 版的一个已知行为差异，移植时特意修正（详见函数级注释）：
 * Python 的 `sandbox/routers/session_workspace.py` 把
 * `WorkspaceCleanupError` 的 `str(exc)` 原样塞进 HTTP 503 的 `detail` 字段
 * ——而 `remove_workspace()` 内部拼接的错误文本直接来自 `shutil.rmtree()`
 * 抛出的 `OSError`，那类错误的 `str()` 天然带物理路径（例如
 * `[Errno 39] Directory not empty: '/var/sandbox/workspaces/xxx/sub'`）。
 * 这是一个真实的物理路径泄漏点，不是我们要延续的设计。这里的
 * `removeWorkspace()` 保证 `WorkspaceCleanupError.message` 在构造时就已经
 * 脱敏，调用方即使像 Python 版一样直接把 `.message` 塞进响应体也不会泄漏。
 */
import { access, mkdir, rm, statfs } from 'node:fs/promises';
import { redactPhysicalRoots } from '../fs/redact.js';
import { joinContained, validateOpaqueId } from './ids.js';
import { initTempTree, physicalTempPath } from './temp-tree.js';

export class WorkspaceCleanupError extends Error {
  override readonly name = 'WorkspaceCleanupError';
}

export interface WorkspaceLifecycleConfig {
  /** 全部工作区的物理基础根：`workspacesBaseRoot/{workspaceId}` 是单个工作区。 */
  readonly workspacesBaseRoot: string;
  /** 全部持久 temp 树的物理基础根，见 `temp-tree.ts`。 */
  readonly tempBaseRoot: string;
}

export interface WorkspaceRoots {
  readonly workspaceRoot: string;
  readonly tempRoot: string;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * 删除一棵目录树并校验删除后确实不在了；失败时返回可读的错误描述（已脱敏），
 * 成功或"本来就不存在"都返回 `null`。不存在不算错误——与 Python 版
 * `if ws.exists(): try rmtree...` 的"跳过不存在的树"语义一致。
 */
async function removeTreeVerified(target: string, label: string): Promise<string | null> {
  if (!(await pathExists(target))) {
    return null;
  }
  try {
    await rm(target, { recursive: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `${label}: ${redactPhysicalRoots(message, [target])}`;
  }
  if (await pathExists(target)) {
    return `${label}: tree still present after removal attempt`;
  }
  return null;
}

/** 管理 AgentSession 拥有的工作区目录树（含配对 temp）。 */
export class WorkspaceManager {
  constructor(private readonly config: WorkspaceLifecycleConfig) {}

  /** 物理工作区根（可能尚未创建）。 */
  physicalWorkspacePath(workspaceId: string): string {
    return joinContained(this.config.workspacesBaseRoot, validateOpaqueId(workspaceId, 'workspace_id'));
  }

  /** 配对的持久 temp 根（可能尚未创建）。 */
  physicalTempPath(workspaceId: string): string {
    return physicalTempPath(this.config.tempBaseRoot, workspaceId);
  }

  /**
   * 创建一个空的工作区目录 + 配对的持久 temp 目录。
   *
   * 与 Python 版一致：不添加 skill 符号链接、不预置任何种子文件夹——skill
   * 只通过 Bubblewrap 只读绑定可见（ADR 0008 D4），这层不掺和。
   */
  async initWorkspace(workspaceId: string): Promise<WorkspaceRoots> {
    const safeId = validateOpaqueId(workspaceId, 'workspace_id');
    await mkdir(this.config.workspacesBaseRoot, { recursive: true });
    const workspaceRoot = this.physicalWorkspacePath(safeId);
    await mkdir(workspaceRoot, { recursive: true });
    const tempRoot = await initTempTree(this.config.tempBaseRoot, safeId);
    return { workspaceRoot, tempRoot };
  }

  /**
   * 删除一个 AgentSession 拥有的工作区目录树 + 配对 temp。
   *
   * 由 Session / AgentSession 关闭触发——绝不是 Conversation 生命周期
   * （沿用 Python 版注释里记录的 D2 决策：会话内多轮 Run 共享同一个工作区，
   * 删除必须等到整个会话结束）。
   *
   * 失败（`WorkspaceCleanupError`）时，**调用方不得释放 AgentSession/工作区
   * 绑定**——残留数据 + 释放掉的绑定会让新会话复用到旧数据。这条不变量原样
   * 保留自 Python 版文档字符串，只是现在是类型系统之外的调用约定，需要
   * 调用方（W3-A 的会话生命周期编排）遵守。
   */
  async removeWorkspace(workspaceId: string): Promise<void> {
    const safeId = validateOpaqueId(workspaceId, 'workspace_id');
    const workspaceRoot = this.physicalWorkspacePath(safeId);
    const tempRoot = this.physicalTempPath(safeId);

    const errors: string[] = [];
    const workspaceError = await removeTreeVerified(workspaceRoot, 'workspace');
    if (workspaceError) errors.push(workspaceError);
    const tempError = await removeTreeVerified(tempRoot, 'temp');
    if (tempError) errors.push(tempError);

    if (errors.length > 0) {
      throw new WorkspaceCleanupError(
        `Workspace cleanup failed; binding must not be released: ${errors.join('; ')}`,
      );
    }
  }

  /** 工作区基础根所在文件系统的可用空间（MiB）。与 Python 版
   * `os.statvfs` 等价物：Node 的 `fs.promises.statfs()`（Node >= 19）。 */
  async diskFreeMb(): Promise<number> {
    await mkdir(this.config.workspacesBaseRoot, { recursive: true });
    try {
      const st = await statfs(this.config.workspacesBaseRoot);
      return (st.bsize * st.bavail) / (1024 * 1024);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(redactPhysicalRoots(message, [this.config.workspacesBaseRoot]));
    }
  }
}
