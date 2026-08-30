/**
 * boot 完整插件树，把"实际挂载了谁"打成一行 JSON。
 *
 * 为什么是独立进程：boot() 起的插件树没有便捷的 dispose 接口，留在测试进程里
 * 会让事件循环不空、`node:test` 挂住。组合断言本来也是进程级的事实。
 */
import { bootEnterpriseRuntime } from '../../src/boot.js';

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
  })}\n`,
);
process.exit(0);
