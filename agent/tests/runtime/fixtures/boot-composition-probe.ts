/**
 * boot 完整插件树，把"实际挂载了谁"打成一行 JSON。
 *
 * 为什么是独立进程：boot() 起的插件树没有便捷的 dispose 接口，留在测试进程里
 * 会让事件循环不空、`node:test` 挂住。组合断言本来也是进程级的事实。
 */
import { bootEnterpriseRuntime } from '../../../src/runtime/boot.js';

process.env['LLMIO_API_KEY'] ??= 'boot-probe-key';
process.env['SANDBOX_INTERNAL_HMAC_KEYRING'] ??=
  '{"k1":"a2tra2tra2tra2tra2tra2tra2tra2tra2tra2tra2s"}';
process.env['SANDBOX_INTERNAL_HMAC_ACTIVE_KID'] ??= 'k1';
process.env['SANDBOX_BASE_URL'] ??= 'http://sandbox:8081';

const ctx = await bootEnterpriseRuntime();
const get = (name: string): { constructor?: { name?: string } } | undefined =>
  (ctx as unknown as { get(n: string): never }).get(name);

const subagents = get('subagents') as unknown as {
  getProvider(name: string): { inheritsParentContext: boolean; capabilities: unknown } | undefined;
};
const spawn = subagents.getProvider('spawn');

// 模型可见的工具面（ADR 0009 D3 / 计划 H2.7）。走出厂公开 API
// `ToolRuntime.schemas()`——就是模型实际收到的那份清单，不是 patch 里写了什么。
const tools = get('tools') as unknown as { schemas(): Array<{ name: string }> } | undefined;
const toolNames = tools === undefined ? null : tools.schemas().map((t) => t.name).sort();

process.stdout.write(
  `${JSON.stringify({
    credentials: get('credentials')?.constructor?.name ?? null,
    fs: get('fs')?.constructor?.name ?? null,
    shell: get('shell')?.constructor?.name ?? null,
    jobs: get('jobs')?.constructor?.name ?? null,
    spawnProvider:
      spawn === undefined
        ? null
        : { inheritsParentContext: spawn.inheritsParentContext, capabilities: spawn.capabilities },
    toolNames,
    // seam 在不在：D5 要 approval 开、permission 关；subprocess 必须缺席（D8/D11）。
    seams: {
      approval: get('approval') !== undefined,
      permissionPresets: get('permissionPresets') !== undefined,
      userQuestions: get('userQuestions') !== undefined,
      subprocess: get('subprocess') !== undefined,
    },
  })}\n`,
);
process.exit(0);
