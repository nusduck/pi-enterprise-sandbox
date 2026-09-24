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

// 每个工具的 `parameters` 必须是**合法的 object 节点**。
// 抄成出厂 `defineTool()` 的简写（`{ pattern: { type, required } }`）时注册照样
// 成功、名字照样出现在注册表里——只有真开一轮时模型提供方才会拒
// "Invalid schema for function 'glob'"，而那时整个 Run 失败。
const badSchemas =
  tools === undefined
    ? []
    : (tools.schemas() as Array<{ name: string; parameters?: unknown }>)
        .filter((t) => {
          const p = t.parameters as
            | { type?: unknown; properties?: Record<string, { required?: unknown }> }
            | undefined;
          if (p === undefined || p.type !== 'object' || typeof p.properties !== 'object') return true;
          // 必填项必须是顶层 `required` 数组。属性上的 `required: true` 是出厂
          // `defineTool()` 的入参写法，直接写进注册 schema 会让模型提供方拒
          // "true is not of type array" —— 而注册本身照样成功。
          return Object.values(p.properties ?? {}).some(
            (prop) => prop !== null && typeof prop === 'object' && 'required' in prop,
          );
        })
        .map((t) => t.name);

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
    badSchemas,
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
