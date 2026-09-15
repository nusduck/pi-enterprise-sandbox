/**
 * Agent Worker 的探针 listener（design §9.2）。
 *
 * Worker 不发布业务 HTTP 面，但 K8s 需要 liveness / readiness。这里只开两条只读路由：
 *
 * - `GET /health`：事件循环活着就 200。不查依赖——数据库临时不可用不能让 liveness
 *   把所有 Pod 同时重启。
 * - `GET /ready`：启动完成、消费者在跑、未进入关停，且本次 MySQL `SELECT 1` 与
 *   Redis `PING` 都在超时内成功，才 200；否则 503。无任务时照样就绪，不看
 *   "最近完成任务时间"。
 *
 * 其他路径一律 404，不回显任何内部状态细节以外的东西。
 */
import http from 'node:http';

export const DEFAULT_AGENT_WORKER_PROBE_PORT = 4101;
export const DEFAULT_AGENT_WORKER_PROBE_CHECK_TIMEOUT_MS = 2000;

export interface WorkerProbeState {
  /** 容器与消费者均已启动。 */
  readonly started: () => boolean;
  /** 已收到关停信号：先让 readiness 变 false，再停消费。 */
  readonly shuttingDown: () => boolean;
  /** BullMQ 消费者当前在跑（未关闭）。 */
  readonly consumerRunning: () => boolean;
  readonly pingMysql: () => Promise<unknown>;
  readonly pingRedis: () => Promise<unknown>;
}

export interface WorkerProbeOptions {
  readonly port: number;
  readonly host?: string;
  readonly checkTimeoutMs?: number;
}

/** 解析探针端口。空值取默认；非法值拒绝启动（配置错误不静默改用别的端口）。 */
export function resolveWorkerProbePort(value: unknown): number {
  if (value == null || String(value).trim() === '') return DEFAULT_AGENT_WORKER_PROBE_PORT;
  const raw = String(value).trim();
  const parsed = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error('AGENT_WORKER_PROBE_PORT must be an integer between 1 and 65535');
  }
  return parsed;
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

export async function evaluateWorkerReadiness(
  state: WorkerProbeState,
  checkTimeoutMs = DEFAULT_AGENT_WORKER_PROBE_CHECK_TIMEOUT_MS,
) {
  const started = safeFlag(state.started);
  const shuttingDown = safeFlag(state.shuttingDown);
  const consumer = safeFlag(state.consumerRunning);
  // 未启动或关停中不再打依赖，避免关停时对已关闭的连接发查询。
  const probeDeps = started && !shuttingDown;
  const [mysql, redis] = probeDeps
    ? await Promise.all([
        withinTimeout(state.pingMysql, checkTimeoutMs),
        withinTimeout(state.pingRedis, checkTimeoutMs),
      ])
    : [false, false];
  const ready = started && !shuttingDown && consumer && mysql && redis;
  return {
    ready,
    body: {
      status: ready ? 'ready' : 'not_ready',
      started,
      shutting_down: shuttingDown,
      consumer: consumer ? 'running' : 'stopped',
      mysql: mysql ? 'ok' : 'unavailable',
      redis: redis ? 'ok' : 'unavailable',
    },
  };
}

function safeFlag(read: () => boolean): boolean {
  try {
    return read() === true;
  } catch {
    return false;
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function createWorkerProbeServer(state: WorkerProbeState, options: WorkerProbeOptions): http.Server {
  const checkTimeoutMs = options.checkTimeoutMs ?? DEFAULT_AGENT_WORKER_PROBE_CHECK_TIMEOUT_MS;
  const server = http.createServer((req, res) => {
    const path = (req.url ?? '').split('?', 1)[0];
    if (req.method === 'GET' && path === '/health') {
      sendJson(res, 200, { status: 'ok', service: 'pi-enterprise-agent-worker' });
      return;
    }
    if (req.method === 'GET' && path === '/ready') {
      void evaluateWorkerReadiness(state, checkTimeoutMs).then(
        ({ ready, body }) => sendJson(res, ready ? 200 : 503, body),
        () => sendJson(res, 503, { status: 'not_ready' }),
      );
      return;
    }
    sendJson(res, 404, { error: 'not_found' });
  });
  // 探针请求很短；不给慢连接占住 listener 的机会。
  server.requestTimeout = checkTimeoutMs * 2 + 1000;
  server.headersTimeout = 5000;
  return server;
}

export async function startWorkerProbeServer(
  state: WorkerProbeState,
  options: WorkerProbeOptions,
): Promise<http.Server> {
  const server = createWorkerProbeServer(state, options);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host ?? '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}

export async function closeWorkerProbeServer(server: http.Server | null | undefined): Promise<void> {
  if (!server?.listening) return;
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
