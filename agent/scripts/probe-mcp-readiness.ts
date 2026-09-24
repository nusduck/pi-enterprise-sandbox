/**
 * K8s 部署评审 K2 取证：已启用但连不上的 MCP 服务器必须出现在就绪投影里并使
 * `ready: false`，不能因为没注册工具就从清单里消失。
 *
 * 用真插件树（出厂 `dsh-mcp-client`），不是注册表桩。输出一行 JSON 供测试断言。
 *
 * 用法：
 *   MCP_SERVERS_JSON='[{"serverId":"echo","command":"node","args":["<fixture>"]},
 *                      {"serverId":"dead","url":"http://127.0.0.1:9/mcp"}]' \
 *   npx tsx scripts/probe-mcp-readiness.ts
 */
import { readMcpReadiness } from '../src/runtime/boot.js';

const readiness = await readMcpReadiness();
console.log(`READINESS ${JSON.stringify(readiness)}`);
process.exit(0);
