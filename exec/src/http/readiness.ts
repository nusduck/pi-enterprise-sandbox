/**
 * 执行面就绪判定（design §9.2）。
 *
 * `/health` 只表示进程活着；`/ready` 才是 LB / facade 判断「能不能接流量」的依据。
 * 2026-09-15 之前两者是同一个恒返回 ok 的处理器，文档里写的预检并不存在。
 *
 * 每次请求实时检查：数据库 `SELECT 1`、四个数据根可读写且是目录。隔离（bwrap）
 * 不在每次请求里 spawn——代价太大——而是读启动期 `preflight()` 的结果；没跑过
 * 预检（`unchecked`）同样不就绪。
 *
 * 响应只给各项 ok / unavailable，不给路径、错误文本或 DSN。
 */
import { constants as fsConstants } from 'node:fs';
import { access, stat } from 'node:fs/promises';

export const EXEC_READINESS_CHECK_TIMEOUT_MS = 2000;

export type IsolationState = 'unchecked' | 'ok' | 'unavailable';

export interface StorageRoot {
  /** 对外的项名（workspaces / tmp / artifacts / control），不是路径。 */
  readonly name: string;
  readonly path: string;
}

export interface ExecReadinessInput {
  /** 未配置数据库（非生产内存模式）时省略。 */
  readonly pingDatabase?: (() => Promise<unknown>) | undefined;
  readonly storageRoots: readonly StorageRoot[];
  readonly isolation: () => IsolationState;
  readonly shuttingDown: () => boolean;
  readonly timeoutMs?: number;
}

export interface ExecReadiness {
  readonly ready: boolean;
  readonly body: Record<string, unknown>;
}

async function withinTimeout(check: () => Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(check)
        .then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function rootUsable(root: string): Promise<void> {
  const info = await stat(root);
  if (!info.isDirectory()) throw new Error('not a directory');
  await access(root, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK);
}

export async function evaluateExecReadiness(input: ExecReadinessInput): Promise<ExecReadiness> {
  const timeoutMs = input.timeoutMs ?? EXEC_READINESS_CHECK_TIMEOUT_MS;
  if (input.shuttingDown()) {
    // 关停中不再打依赖：连接池可能已经在关。
    return { ready: false, body: { status: 'not_ready', shutting_down: true } };
  }

  const isolation = input.isolation();
  const [database, ...storageResults] = await Promise.all([
    input.pingDatabase === undefined
      ? Promise.resolve<boolean | null>(null)
      : withinTimeout(input.pingDatabase, timeoutMs),
    ...input.storageRoots.map((root) => withinTimeout(() => rootUsable(root.path), timeoutMs)),
  ]);

  const storage: Record<string, 'ok' | 'unavailable'> = {};
  input.storageRoots.forEach((root, index) => {
    storage[root.name] = storageResults[index] ? 'ok' : 'unavailable';
  });

  const ready =
    isolation === 'ok' && database !== false && storageResults.every((ok) => ok === true);
  return {
    ready,
    body: {
      status: ready ? 'ready' : 'not_ready',
      shutting_down: false,
      database: database === null ? 'not_configured' : database ? 'ok' : 'unavailable',
      storage,
      isolation: isolation === 'ok' ? 'ok' : isolation,
    },
  };
}
