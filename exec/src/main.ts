/**
 * Exec HTTP 入口。Wave 6 起取代 Python sandbox 服务进程。
 * 挂载内部 HMAC 面与公共会话面；健康检查保持 /health 与 /ready。
 */
import { createExecAppFromEnv } from './http/app.js';
import { listenHono } from './http/node-listener.js';

const port = Number.parseInt(process.env['EXEC_PORT'] ?? process.env['SANDBOX_PORT'] ?? '8081', 10);
const runtime = createExecAppFromEnv();
const server = listenHono(runtime.app, port);

const shutdown = (): void => {
  server.close(() => {
    void runtime.dispose().finally(() => process.exit(0));
  });
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
