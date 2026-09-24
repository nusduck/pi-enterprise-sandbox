/**
 * H7.8 取证：出厂 `dsh-mcp-client` 真的连上一台 MCP 服务器、注册工具、调得通。
 *
 * 用真协议（`tests/runtime/fixtures/mcp-echo-server.mjs`，官方 SDK 的 stdio server），
 * 不是 transport 桩——桩只能证明我们对协议的想象是自洽的。
 *
 * 用法：
 *   MCP_SERVERS_JSON='[{"serverId":"echo","command":"node","args":["<fixture>"]}]' \
 *   npx tsx scripts/probe-mcp-live.ts
 */
import { bootEnterpriseRuntime } from '../src/runtime/boot.js';

const ctx: any = await bootEnterpriseRuntime();
const tools: any = ctx.get('tools');
const names: string[] = tools.schemas().map((s: { name: string }) => s.name).sort();
const mcpNames = names.filter((n) => n.startsWith('mcp__'));

console.log(`registry: ${names.length} tools, ${mcpNames.length} from MCP`);
console.log(`mcp tools: ${JSON.stringify(mcpNames)}`);

const target = mcpNames.find((n) => n.endsWith('__echo'));
if (target === undefined) {
  console.error('FAIL: no mcp__<server>__echo in the registry');
  process.exit(1);
}

const def = tools.get(target);
if (def === undefined || typeof def.execute !== 'function') {
  console.error(`FAIL: ${target} has no executable definition`);
  process.exit(1);
}

const value = await def.execute(
  { text: 'hello-from-h7-8' },
  { signal: new AbortController().signal, deferContext() {}, concludeTurn() {} },
);
console.log(`call result: ${JSON.stringify(value)}`);

const rendered = def.output.render({ text: 'hello-from-h7-8' }, value);
const text = JSON.stringify(rendered);
if (!text.includes('echo:hello-from-h7-8')) {
  console.error(`FAIL: call did not round-trip; got ${text}`);
  process.exit(1);
}
console.log('OK: real MCP server connected, tool registered under the public name, and called through');
process.exit(0);
