/**
 * Exec HTTP 入口。Wave 6 起取代 Python sandbox 服务进程。
 * 挂载内部 HMAC 面与公共会话面；健康检查保持 /health 与 /ready。
 */
import { createExecAppFromEnv } from './http/app.js';
import { listenHono } from './http/node-listener.js';

const port = Number.parseInt(process.env['EXEC_PORT'] ?? process.env['SANDBOX_PORT'] ?? '8081', 10);
const runtime = createExecAppFromEnv();

// 先收孤儿，再 listen。顺序是硬要求：`recoverOrphans()` 用 `listActiveForRecovery`
// 做**无租户过滤**的全表扫描，只有在还没有任何用户请求进来的时候才是安全的；
// 而且没收干净就开门的话，上一轮遗留的 `running` 行会一直占着 owner 的并发额度。
// 回收失败即 fail-closed：宁可起不来，也不要带着一批永远躺在 running 的僵尸行
// 对外服务（AGENTS.md §2）。
try {
  const recovered = await runtime.recoverOrphans();
  if (recovered > 0) {
    process.stdout.write(`exec recovered ${recovered} orphaned job(s) at startup\n`);
  }
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`exec orphan recovery failed, refusing to start: ${message}\n`);
  await runtime.dispose().catch(() => undefined);
  process.exit(1);
}

const server = listenHono(runtime.app, port);

const shutdown = (): void => {
  server.close(() => {
    void runtime.dispose().finally(() => process.exit(0));
  });
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
