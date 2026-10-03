/**
 * 外部 MCP 工作区的闲置回收（产品 2026-10-03：闲置 3 天回收）。
 *
 * facade 把外部 `context_id` 映射到工作区，映射在 Redis 里按 TTL 过期；过期后
 * 工作区再也没人能访问，但目录还在磁盘上。这里给 MCP 工作区记活动时间，定期删掉
 * 闲置超过 TTL 的那些。
 *
 * **只动 MCP 工作区**：活动标记只由 MCP 窄桥（`internal-mcp.ts` 的 `contextOf()`）
 * 写入 `<controlRoot>/mcp-workspaces/<workspaceId>`。Agent 会话的工作区永远没有
 * 标记，回收扫描只遍历这个目录，所以碰不到它们。控制根从不 bind 进沙箱，模型
 * 伪造不了标记。
 *
 * 判定依据是标记文件的 mtime：每次窄桥调用都刷新一次。删除失败时保留标记、记日志，
 * 下一轮再试；不会因为一个工作区删不掉而跳过其他的。
 *
 * 本功能上线前已经存在的 MCP 工作区没有标记，不会被回收。
 */
import { mkdir, readdir, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { InvalidWorkspaceIdError, validateOpaqueId } from './ids.js';
import type { WorkspaceManager } from './manager.js';

export const DEFAULT_MCP_WORKSPACE_TTL_SECONDS = 3 * 24 * 3600;
export const MCP_WORKSPACE_SWEEP_INTERVAL_MS = 3600 * 1000;

export interface McpWorkspaceGcOptions {
  /** 标记目录：`<controlRoot>/mcp-workspaces`。 */
  readonly markerDir: string;
  readonly ttlSeconds: number;
  readonly workspaceManager: Pick<WorkspaceManager, 'removeWorkspace'>;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
}

export class McpWorkspaceGc {
  readonly #markerDir: string;
  readonly #ttlMs: number;
  readonly #workspaces: Pick<WorkspaceManager, 'removeWorkspace'>;
  readonly #now: () => number;
  readonly #log: (message: string) => void;
  #timer: NodeJS.Timeout | null = null;
  #sweeping: Promise<number> | null = null;

  constructor(opts: McpWorkspaceGcOptions) {
    if (!Number.isInteger(opts.ttlSeconds) || opts.ttlSeconds < 1) {
      throw new Error('MCP workspace TTL must be a positive integer number of seconds');
    }
    this.#markerDir = opts.markerDir;
    this.#ttlMs = opts.ttlSeconds * 1000;
    this.#workspaces = opts.workspaceManager;
    this.#now = opts.now ?? Date.now;
    this.#log = opts.log ?? ((m) => process.stderr.write(`${m}\n`));
  }

  /**
   * 记一次活动。写标记失败只记日志、不阻断请求：控制根在启动预检时已确认可写，
   * 这里失败属于运行期故障；为它拒绝外部调用代价更大，而后果最多是工作区按上一次
   * 成功记录的时间被回收。
   */
  async touch(workspaceId: string): Promise<void> {
    const safeId = validateOpaqueId(workspaceId, 'workspace_id');
    const marker = path.join(this.#markerDir, safeId);
    const at = new Date(this.#now());
    try {
      await mkdir(this.#markerDir, { recursive: true, mode: 0o700 });
      await writeFile(marker, `${at.toISOString()}\n`, { mode: 0o600 });
      await utimes(marker, at, at);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#log(`exec mcp workspace gc: activity for ${safeId} not recorded: ${message}`);
    }
  }

  /** 扫一轮，返回回收的工作区数。并发调用复用同一轮。 */
  sweep(): Promise<number> {
    if (this.#sweeping === null) {
      this.#sweeping = this.#sweepOnce().finally(() => {
        this.#sweeping = null;
      });
    }
    return this.#sweeping;
  }

  async #sweepOnce(): Promise<number> {
    let names: string[];
    try {
      names = await readdir(this.#markerDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw err;
    }
    let removed = 0;
    for (const name of names) {
      let safeId: string;
      try {
        safeId = validateOpaqueId(name, 'workspace_id');
      } catch (err) {
        if (err instanceof InvalidWorkspaceIdError) continue;
        throw err;
      }
      const marker = path.join(this.#markerDir, safeId);
      try {
        // 删除前再读一次 mtime：扫描期间被刷新过的不删。
        const st = await stat(marker);
        if (!st.isFile() || this.#now() - st.mtimeMs <= this.#ttlMs) continue;
        await this.#workspaces.removeWorkspace(safeId);
        await unlink(marker);
        removed += 1;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        const message = err instanceof Error ? err.message : String(err);
        this.#log(`exec mcp workspace gc: ${safeId} not reclaimed: ${message}`);
      }
    }
    if (removed > 0) this.#log(`exec mcp workspace gc: reclaimed ${removed} idle workspace(s)`);
    return removed;
  }

  /** 立即扫一轮，之后按固定间隔扫；定时器不阻止进程退出。 */
  start(intervalMs = MCP_WORKSPACE_SWEEP_INTERVAL_MS): void {
    if (this.#timer !== null) return;
    const run = (): void => {
      this.sweep().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.#log(`exec mcp workspace gc: sweep failed: ${message}`);
      });
    };
    run();
    this.#timer = setInterval(run, intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }
}

/** `SANDBOX_MCP_WORKSPACE_TTL_SECONDS`：缺省 3 天；给了但不是正整数就拒绝启动。 */
export function readMcpWorkspaceTtlSeconds(env: NodeJS.ProcessEnv): number {
  const raw = env['SANDBOX_MCP_WORKSPACE_TTL_SECONDS'];
  if (raw === undefined || raw.trim() === '') return DEFAULT_MCP_WORKSPACE_TTL_SECONDS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error('SANDBOX_MCP_WORKSPACE_TTL_SECONDS must be a positive integer');
  }
  return value;
}
