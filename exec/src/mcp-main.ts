/**
 * `sandbox-mcp` 进程入口。与 `main.ts`（执行面）是**两个进程、同一个镜像**。
 *
 * 为什么不合成一个：facade 是整个系统里唯一对外暴露的面，它只该持有走窄桥的
 * 那枚 token。跟执行面同进程意味着一次 RCE 就直接拿到内部面的全部能力。
 * 同一个镜像是为了少维护一份 Dockerfile——镜像相同，入口与凭据不同。
 */
import { Redis } from 'ioredis';
import { listenHono } from './http/node-listener.js';
import { SandboxBridgeClient } from './mcp/bridge-client.js';
import { ContextStore, type RedisLike } from './mcp/context-store.js';
import { McpFacadeService } from './mcp/service.js';
import { createMcpApp } from './mcp/server.js';
import { loadMcpSettings } from './mcp/settings.js';

const settings = loadMcpSettings();
const port = Number.parseInt(process.env['SANDBOX_MCP_PORT'] ?? '8082', 10);

const contextStore = new ContextStore(settings, null, async () => {
  // `ioredis` 的接口比 `RedisLike` 宽；这里只用到窄接口里的那几个方法。
  return new Redis(settings.redisUrl, { lazyConnect: false }) as unknown as RedisLike;
});
const service = new McpFacadeService(settings, contextStore, new SandboxBridgeClient(settings));

async function main(): Promise<void> {
  // `start()` 里 `validateRuntime` 会在四个必需密钥缺任何一个时抛——
  // fail-closed：宁可起不来，也不要带着空 token 起来。
  await service.start();
  const server = listenHono(createMcpApp(settings, service), port);

  const shutdown = (): void => {
    server.close(() => {
      void service.close().finally(() => process.exit(0));
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err: unknown) => {
  process.stderr.write(`sandbox-mcp failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
