/**
 * Exec HTTP 入口。Wave 6 起取代 Python sandbox 服务进程。
 * 挂载内部 HMAC 面与公共会话面；健康检查保持 /health 与 /ready。
 *
 * 启动顺序（design §9.2）：取密（UPDRDB + 数据源）→ 装配（建池）→ schema 核对 → 存储与 bwrap 预检 → 孤儿回收 → listen。任何一步失败都退出，
 * 不先对外提供服务。
 */
import { createExecAppFromEnv, readExecDbConfigFromSandboxEnv } from './http/app.js';
import { listenHono } from './http/node-listener.js';
import { resolveExecDbPassword } from './startup-credentials.js';
import { readDataSourceCatalog } from './datasource/catalog.js';
import { fetchDataSourcePasswords } from './datasource/service.js';

const port = Number.parseInt(process.env['EXEC_PORT'] ?? process.env['SANDBOX_PORT'] ?? '8081', 10);

let dbPassword: string | undefined;
try {
  dbPassword = await resolveExecDbPassword(process.env, readExecDbConfigFromSandboxEnv);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`exec credential fetch failed, refusing to start: ${message}\n`);
  process.exit(1);
}

// 数据源口令（design `sandbox-data-sources.md` §4.5）：目录配错、DBPM 端点配错拒绝启动；
// 单个数据源取密失败只让它不可用，平台本身不依赖业务库。
let dataSourcePasswords: ReadonlyMap<string, string>;
try {
  dataSourcePasswords = await fetchDataSourcePasswords(readDataSourceCatalog(process.env), process.env);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`exec data source configuration invalid, refusing to start: ${message}\n`);
  process.exit(1);
}

let runtime: ReturnType<typeof createExecAppFromEnv>;
try {
  runtime = createExecAppFromEnv(process.env, { dbPassword, dataSourcePasswords });
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`exec configuration invalid, refusing to start: ${message}\n`);
  process.exit(1);
}
if (runtime.internalAllowCidr.length === 0) {
  // 空白名单 = 拒绝全部内部面请求。不拒启（公共面、窄桥、探针仍可用），但必须显眼。
  process.stderr.write(
    'exec WARNING: EXEC_INTERNAL_ALLOW_CIDR is empty; every /internal/v1 request will be rejected with 403\n',
  );
}

// schema 核对先于孤儿回收：回收要写 exec_jobs，结构不对时一行都不能动。
try {
  await runtime.verifySchema();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`exec schema verification failed, refusing to start: ${message}\n`);
  await runtime.dispose().catch(() => undefined);
  process.exit(1);
}

// 存储与隔离预检在孤儿回收之前：bwrap 跑不起来的执行面不该动账本，也不该对外开门。
try {
  await runtime.preflight();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`exec storage/isolation preflight failed, refusing to start: ${message}\n`);
  await runtime.dispose().catch(() => undefined);
  process.exit(1);
}

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
  // 先摘除就绪，LB 不再派新请求；在途请求由 server.close 等待结束。
  runtime.markShuttingDown();
  server.close(() => {
    void runtime.dispose().finally(() => process.exit(0));
  });
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
