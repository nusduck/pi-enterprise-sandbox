/**
 * H0.1 取证脚本：起全树 DSH，dump `ctx.tools` 的模型可见工具面。
 *
 * 为什么需要它：`tests/runtime/boot.test.ts` 只对 YAML 做字符串匹配，唯一起栈
 * 的用例只断言 `bootEnterpriseRuntime` 是个函数。在此之前没有任何人验证过
 * boot 之后循环上到底有哪些工具（见 design/dsh-host-tools.md §0 ①）。
 *
 * 枚举走 `ToolRuntime.schemas(scope?)`——出厂公开 API，不省略、不猜形状。
 *
 * 用法（需要 HMAC 占位 env，因为 exec-rpc 是 fail-closed 的）：
 *   SANDBOX_INTERNAL_HMAC_KEYRING='{"boot":"<b64url>"}' \
 *   SANDBOX_INTERNAL_HMAC_ACTIVE_KID=boot \
 *   npx tsx scripts/dump-tool-registry.ts [--json]
 */
import { bootEnterpriseRuntime } from '../src/runtime/boot.js';

const ctx: any = await bootEnterpriseRuntime();
const tools: any = ctx.get('tools');
if (tools === undefined) throw new Error('dump: ctx.tools not mounted');

const schemas: any[] = tools.schemas();
const rows = schemas
  .map((s) => ({ name: String(s?.name ?? '<unnamed>'), description: String(s?.description ?? '').split('\n')[0] }))
  .sort((a, b) => a.name.localeCompare(b.name));

if (process.argv.includes('--json')) {
  process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
} else {
  process.stdout.write(`# ctx.tools.schemas() —— 全局视图，${rows.length} 个模型可见工具\n\n`);
  process.stdout.write('| 工具名 | 描述首行 |\n|---|---|\n');
  for (const r of rows) process.stdout.write(`| \`${r.name}\` | ${r.description.slice(0, 90)} |\n`);
}

// seam 存在性：D5 要 approval 开、permission 关；D3 要 fs/shell/jobs 是我们的 remote 实现。
process.stdout.write('\n# seams\n\n| seam | 在？ | 实现类 |\n|---|---|---|\n');
for (const s of ['approval', 'permissionPresets', 'userQuestions', 'fs', 'shell', 'jobs', 'skills', 'subagents', 'credentials', 'sessionPersistence']) {
  const v = ctx.get(s);
  process.stdout.write(`| \`ctx.${s}\` | ${v !== undefined ? '✓' : '✗'} | ${v?.constructor?.name ?? '—'} |\n`);
}

// D9 §4 的悬念：有没有按 agent/session 收窄注册面的机制。
process.stdout.write('\n# 收窄机制（ADR 0009 D9 §4）\n\n');
for (const m of ['restrict', 'guard', 'schemas', 'get', 'register']) {
  process.stdout.write(`  ${typeof tools[m] === 'function' ? '✓' : '✗'} ctx.tools.${m}()\n`);
}
process.exit(0);
