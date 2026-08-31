/**
 * `glob` / `grep` 的模型工具面——注册名与出厂 `dsh-tool-fs-search` **逐字一致**，
 * 执行改走 exec 的 `/internal/v1/fs/find` 与 `/internal/v1/fs/grep`（ADR 0009 D8）。
 *
 * ## 为什么不用出厂那个
 *
 * 出厂 `tool-fs-search` 直接在本进程 `ctx.subprocess` 里跑 ripgrep，而
 * ADR 0007 D11 定了「本机执行族一律不挂」——`subprocess` 在 overlay 里是 disabled 的。
 * 为它单独恢复 `subprocess` 会把「agent 进程里没有执行面」这条边界糊掉，
 * 所以搜索走 RPC，ripgrep 在 exec 容器的 bwrap 里跑。
 *
 * ## 为什么名字和 schema 必须抄出厂的
 *
 * 名字是契约面：风险表、`config/agent/tool-risk.json`、前端卡片、模型的提示词
 * 都只认一套。将来若换回出厂实现（例如 agent 进程里真的有了执行面），
 * **不应该有任何一处需要改**。所以 `name`/`parameters`/`output.schema` 逐字对齐
 * `@deepseek-ai/dsh-tool-fs-search@0.1.1-rc.2`，只有 `execute` 不同。
 *
 * 差异只有一处，写在这里免得日后当 bug 查：出厂 `glob` 的结果是**按修改时间排序**
 * 的（ripgrep 那边排的），exec 的 `find` 按自己的顺序返回。两边都不承诺稳定顺序，
 * 模型侧也不依赖顺序，所以不为此加一次额外的 stat 遍历。
 */

import type { Context } from '@deepseek-ai/cordis';
import { ExecRpcClient, currentExecRpc, resolveExecRpcConfig } from './exec-rpc.js';
import type { ExecRpcConfig } from './exec-rpc.js';

/** exec `/internal/v1/fs/find` 的响应。 */
interface FindResponse {
  readonly items: ReadonlyArray<{ path: string; name: string; type: string; size: number }>;
  readonly truncated: boolean;
}

/** exec `/internal/v1/fs/grep` 的响应。 */
interface GrepResponse {
  readonly matches: ReadonlyArray<{ path: string; line: number; column: number; text: string }>;
  readonly truncated: boolean;
}

/**
 * 把工具参数里的 `path` 解析成一个 `FsTarget`。
 *
 * 复用 `ctx.fs.resolve()`——围栏只有一处（ADR 0008 D2 的纪律），
 * 搜索不自己再算一遍路径。`path` 省略时交给 exec 侧默认到会话工作区。
 */
async function targetOf(ctx: { fs?: { resolve(p: string): Promise<unknown> } }, path?: string): Promise<unknown> {
  const fs = ctx.fs;
  if (fs === undefined) throw new Error('remote-fs-search: ctx.fs is not mounted');
  return fs.resolve(path === undefined || path === '' ? '.' : path);
}

export const name = 'remote-fs-search';
/**
 * **必须经 inject 声明**：直接 `ctx.tools` 会抛 "cannot get property tools without
 * inject"。而且本模块**不能有 default export**——加了之后 loader 取的是那个函数，
 * 看不到这里的 `inject`，于是同样抛。两条都是实跑撞出来的
 * （同一个坑 runtime-factory.ts 的 systemPrompt 注释里也记过）。
 */
export const inject = ['tools', 'fs'] as const;

/**
 * 生成器式插件：cordis 把 `apply` yield 出的每个 disposer 收进本插件的 scope，
 * 卸载时逐个调用。比自己挂 `dispose` 监听更贴合 HMR 与 scope 卸载语义。
 */
export function* apply(ctx: Context & Record<string, any>, config: Partial<ExecRpcConfig> = {}) {
  // 构造期用环境占位；每次调用取 ALS 里本 Run 的租户（并发 Run 不能共用一份配置，
  // ADR 0009 D3——这正是 runtime-factory 那个 rebind 写法出问题的地方）。
  const fallback = resolveExecRpcConfig(config);
  const rpcFor = (): ExecRpcClient => new ExecRpcClient(currentExecRpc(fallback));
  const rootsFor = (): readonly string[] => currentExecRpc(fallback).physicalRoots;

  yield ctx.tools.register({
      name: 'glob',
      description:
        'Find files whose paths match a glob pattern. Returns matching file paths — never directories — including hidden and ignored files (VCS metadata directories are excluded). This tool does not enumerate directory entries.',
      // **完整 JSON Schema，不是出厂 `defineTool` 的简写。** 出厂
      // `dsh-tool-fs-search` 写的是 `{ pattern: { type, required, description } }`
      // ——那是 `defineTool()` 的入参形式，由它转换成 schema。我们直接调
      // `ctx.tools.register()`，拿到的就是最终 schema，必须自己写成 object 节点。
      //
      // 抄错的后果**单测抓不到**：注册照样成功、名字照样出现在注册表里，
      // 只有真开一轮时模型提供方才会拒 "Invalid schema for function 'glob'"，
      // 而那时整个 Run 失败。2026-08-31 compose 端到端第一次开 Run 就撞上了。
      parameters: {
        type: 'object',
        // 必填项是**顶层的 `required` 数组**，不是属性上的 `required: true`。
        // 后者是出厂 `defineTool()` 的入参写法，由它转换；我们直接
        // `ctx.tools.register()`，写进去的就是最终 schema。
        // 照抄的是出厂 `read` 注册后的真实形状（`tools.schemas()` dump 出来的），
        // 不是照文档猜的。
        required: ['pattern'],
        properties: {
          pattern: {
            type: 'string',
            description:
              'Glob pattern to match file paths against (e.g. "**/*.ts", "src/**/*.test.js"). A pattern with no "/" matches the basename at any depth, so "*" and "*.ts" both search the whole tree; include a separator to anchor the depth.',
          },
          path: {
            type: 'string',
            description:
              'Directory to search in. Defaults to the session workspace; a relative path resolves against it.',
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            root: { type: 'string' },
            paths: { type: 'array', items: { type: 'string' } },
          },
        },
        render: (_args: unknown, value: any) => [
          {
            type: 'text',
            text:
              value.paths.length === 0
                ? 'No files matched.'
                : value.paths.join('\n'),
          },
        ],
      },
      async execute(args: any) {
        const pattern = String(args?.pattern ?? '');
        const path = typeof args?.path === 'string' ? args.path : undefined;
        const target = await targetOf(ctx, path);
        const res = await rpcFor().post<Record<string, unknown>, FindResponse>(
          '/internal/v1/fs/find',
          { target, pattern, options: { type: 'file' } },
          rootsFor(),
        );
        return {
          root: path ?? '.',
          // 出厂契约是「只回文件，不回目录」。exec 侧已按 type:'file' 过滤，
          // 这里再挡一次——两边任何一边放松了，模型看到的结果都不该变。
          paths: res.items.filter((i) => i.type !== 'directory').map((i) => i.path),
        };
      },
  });

  yield ctx.tools.register({
      name: 'grep',
      description:
        'Search file contents with a ripgrep regular expression. Returns matching lines with line numbers, grouped by file. Use read on a matched file for surrounding context.',
      parameters: {
        type: 'object',
        required: ['pattern'],
        properties: {
          pattern: {
            type: 'string',
            description: 'Regular expression to search for (ripgrep syntax).',
          },
          path: {
            type: 'string',
            description:
              'File or directory to search. Defaults to the session workspace; a relative path resolves against it.',
          },
          include: {
            type: 'string',
            description:
              'One glob filter for which files to search (e.g. "*.ts", "*.{js,jsx}"). Not a list; negation is not supported.',
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            matches: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  path: { type: 'string' },
                  lineNumber: { type: 'integer' },
                  line: { type: 'string' },
                },
              },
            },
          },
        },
        render: (_args: unknown, value: any) => [
          {
            type: 'text',
            text:
              value.matches.length === 0
                ? 'No matches found.'
                : value.matches
                    .map((m: any) => `${m.path}:${m.lineNumber}:${m.line}`)
                    .join('\n'),
          },
        ],
      },
      async execute(args: any) {
        const pattern = String(args?.pattern ?? '');
        const path = typeof args?.path === 'string' ? args.path : undefined;
        const include = typeof args?.include === 'string' ? args.include : undefined;
        const target = await targetOf(ctx, path);
        const res = await rpcFor().post<Record<string, unknown>, GrepResponse>(
          '/internal/v1/fs/grep',
          {
            target,
            pattern,
            options: { regex: true, ...(include !== undefined ? { glob: include } : {}) },
          },
          rootsFor(),
        );
        // exec 用 `line`/`text`，出厂工具面用 `lineNumber`/`line`。翻译只在这一处。
        return {
          matches: res.matches.map((m) => ({
            path: m.path,
            lineNumber: m.line,
            line: m.text,
          })),
        };
      },
  });
}
