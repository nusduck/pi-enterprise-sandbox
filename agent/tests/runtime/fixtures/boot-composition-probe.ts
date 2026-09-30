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

// Skill 发现面（ADR 0015 D4 / design §6.5）。
//
// 出厂的 `skill-filesystem` 注册在**全局层**，默认根不经过任何 AgentVersion 绑定
// 过滤。`SkillRegistry.collectFresh` 是「全局层 → 该 agent 的 scope 链」按名字合并，
// 后者覆盖前者——所以全局层扫到的包**不会**被 agent scope 里的 run-filesystem 盖掉。
//
// 这里断言的是**注册表本身**，不是「默认根恰好没有 SKILL.md」：
//   - 文件系统发现面在 boot 树里走 `ctx.fs`（RemoteFileSystem，沙箱内），
//     测试进程外面造的夹具根根本读不到，用它做探针只会得到假绿；
//   - 而「全局层还剩哪些 provider」才是真正的安全边界事实。
// `layers` 是 SkillRegistry 的私有字段。拿不到就抛——让它红，不要静默通过：
// 一个永远为空的探针比没有探针更糟（2026-08 credentials 事故的形状）。
const skills = get('skills') as unknown as {
  layers?: { global?: { providers?: Map<string, { provider?: { name?: string } }> } };
} | undefined;
const globalLayers = skills?.layers?.global;
if (globalLayers?.providers === undefined) {
  throw new Error(
    'boot-composition-probe: ctx.skills.layers.global.providers is unavailable; ' +
      'the global-skill-surface assertion below can no longer see what it checks. ' +
      'Re-derive it against the current @deepseek-ai/dsh-skill SkillRegistry shape.',
  );
}
const globalSkillProviders = [...globalLayers.providers.values()].map(
  (entry) => entry.provider?.name ?? '(unnamed)',
);

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
    globalSkillProviders,
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
