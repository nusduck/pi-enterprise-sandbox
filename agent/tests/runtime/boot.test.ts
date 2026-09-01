/**
 * W4-D 组合层：叠在 dsh-base 上，deepseek-official 指向配置网关，本机执行族关闭。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { SessionStore } from '@deepseek-ai/dsh-session';
import { bootEnterpriseRuntime, createRemoteProviders, createSessionBackend ,
  mountSessionPersistence,
  assertOverlayPatchResolvable,
  resolvePathRelativeTo,
} from '../../src/runtime/boot.js';
import { InMemorySessionStore } from '../../src/runtime/providers/mysql-session-store.js';
import { ENTERPRISE_DEFAULT_TOOLS } from '../../src/runtime/policy/tool-names.js';

const patchPath = join(dirname(fileURLToPath(import.meta.url)), '../../src/runtime/bundle/cordis.patch.yml');

test('cordis.patch.yml：凭据只读 env，网关走 LLMIO_BASE_URL，本机执行族 disabled', () => {
  const yaml = readFileSync(patchPath, 'utf8');
  assert.match(yaml, /id: credentials/);
  assert.match(yaml, /env-credentials\.js/);
  assert.match(yaml, /id: llm-deepseek/);
  assert.match(yaml, /apiKeyEnv: LLMIO_API_KEY/);
  assert.match(yaml, /LLMIO_BASE_URL/);
  for (const id of [
    'sandbox',
    'sandbox-policy',
    'bash-sandbox',
    'pwsh-sandbox',
    'fs-sandbox',
    'subprocess',
    'jobs',
    'permission',
    'session-persistence-jsonl',
    'tool-fs-search',
    'tool-pwsh',
    // ADR 0009 D3 的实测补充：这些在 dsh-base 里本来就是激活的，ADR 完全没提，
    // 起栈才发现模型能看见它们。处置理由逐条写在 manifest.ts 的 DISABLED 里。
    'web',
    'web-search-deepseek',
    'tool-web',
    'tool-workflow',
    'tool-ralph',
    'tool-subagent-fork',
    'subagent-fork-in-process',
    'tool-subagent-control',
    'tool-goal',
    'plan-mode',
    'tool-str-replace-editor',
  ]) {
    const block = yaml.split(`- id: ${id}\n`)[1]?.slice(0, 80) ?? '';
    assert.match(block, /disabled:\s*true/, `expected ${id} disabled`);
  }
  assert.match(yaml, /id: remote-fs/);
  assert.match(yaml, /\.\.\/providers\/remote-fs\.js/);
  assert.match(yaml, /id: remote-shell/);
  assert.match(yaml, /\.\.\/providers\/remote-shell\.js/);
  assert.match(yaml, /id: remote-jobs/);
  assert.match(yaml, /\.\.\/providers\/remote-jobs\.js/);
  assert.equal(yaml.includes('id: tool-bash\n  disabled: true'), false);
  assert.equal(yaml.includes('id: tool-fs\n  disabled: true'), false);

  // approval **不再** disabled（ADR 0009 D5 改写了 ADR 0007 D4）。seam 打开，
  // answerer 自建；permission 仍然关着（上面的 disabled 清单里）。
  assert.equal(yaml.includes('id: approval\n  disabled: true'), false);

  // tool-fs-search 关着，但必须有同名替代——否则模型没有搜索工具（ADR 0009 D8）。
  // 「关掉且没人顶上」正是 2026-08-31 之前的状态，这条断言就是为了不再回到那里。
  assert.match(yaml, /id: remote-fs-search/);
  assert.match(yaml, /\.\.\/providers\/remote-fs-search\.js/);

  // ask_user_question：base 只带 seam 不带工具，必须显式加这个包（ADR 0009 D3）。
  assert.match(yaml, /@deepseek-ai\/dsh-tool-ask-user/);
  assert.match(yaml, /id: subagent-spawn-in-process/);
  assert.match(yaml, /durable-subagent\.js/);
});

test('createRemoteProviders 装配 RPC 代理且不碰本机路径', () => {
  const ctx = new Context();
  const providers = createRemoteProviders(ctx, {
    baseUrl: 'http://exec',
    keyring: { test: Buffer.from('0'.repeat(32)).toString('base64url') },
    activeKid: 'test',
    orgId: 'o',
    userId: 'u',
    workspaceId: 'w',
    fenceToken: 0,
    physicalRoots: ['/var/sandbox/workspaces/secret'],
    fetchImpl: (async () => new Response(JSON.stringify({ ok: true, data: {} }))) as typeof fetch,
  });
  assert.equal(providers.fs.sandboxMode, undefined);
  assert.equal(providers.shell.sandboxMode, undefined);
});

test('bootEnterpriseRuntime 是可调用的导出（全树 boot 留给真实链路）', () => {
  assert.equal(typeof bootEnterpriseRuntime, 'function');
});

const MYSQL_URL_KEYS = [
  'MYSQL_HOST',
  'DB_HOST',
  'EXEC_DB_HOST',
  'AGENT_DATABASE_URL',
  'TEST_MYSQL_URL',
  'MYSQL_URL',
  'DATABASE_URL',
] as const;

function withoutMysqlEnv<T>(fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const key of MYSQL_URL_KEYS) {
    prev[key] = process.env[key];
    delete process.env[key];
  }
  try {
    return fn();
  } finally {
    for (const key of MYSQL_URL_KEYS) {
      if (prev[key] !== undefined) process.env[key] = prev[key];
      else delete process.env[key];
    }
  }
}

test('createSessionBackend 缺 MySQL 配回退内存，不红', { concurrency: false }, () => {
  withoutMysqlEnv(() => {
    const store = createSessionBackend({ physicalRoots: [] });
    assert.equal(store instanceof InMemorySessionStore, true);
    assert.equal(store.name, 'mysql-memory');
  });
});

test('mountSessionPersistence 注入根 ctx 且二次挂载复用同一实例', { concurrency: false }, () => {
  withoutMysqlEnv(() => {
    const ctx = new Context();
    new SessionStore(ctx);
    const first = mountSessionPersistence(ctx, { physicalRoots: [] });
    const second = mountSessionPersistence(ctx, { physicalRoots: [] });
    assert.equal(typeof first.bindOwner, 'function');
    assert.equal(typeof second.bindOwner, 'function');
    assert.equal(typeof second.prepare, 'function');
    assert.throws(
      () => mountSessionPersistence(new Context(), { physicalRoots: [] }),
      /ctx.sessions must be mounted/,
    );
  });
});

// ── overlay patch 可解析性 ───────────────────────────────────────────────

test('resolvePathRelativeTo 按 patch 文件所在目录解析相对路径', () => {
  assert.equal(
    resolvePathRelativeTo('/app/runtime/bundle/cordis.patch.yml', '../dist/providers/x.js'),
    '/app/runtime/dist/providers/x.js',
  );
  assert.equal(
    resolvePathRelativeTo('/app/runtime/bundle/cordis.patch.yml', './y.js'),
    '/app/runtime/bundle/y.js',
  );
});

test('assertOverlayPatchResolvable：引用不存在的文件即抛，且指名道姓', () => {
  const exists = (p: string): boolean => p.includes('/dist/');
  // 顶层条目
  assert.throws(
    () =>
      assertOverlayPatchResolvable(
        '/r/bundle/cordis.patch.yml',
        [{ id: 'credentials', name: '../src/providers/env-credentials.js' }],
        exists,
      ),
    /credentials → \.\.\/src\/providers\/env-credentials\.js/,
  );
  // insert 里的条目也要查——remote-* 就在 insert 下面
  assert.throws(
    () =>
      assertOverlayPatchResolvable(
        '/r/bundle/cordis.patch.yml',
        [{ insert: [{ id: 'remote-fs', name: '../src/providers/remote-fs.js' }] }],
        exists,
      ),
    /remote-fs/,
  );
  // 存在的路径不抛；裸模块名不归这里判定
  assert.doesNotThrow(() =>
    assertOverlayPatchResolvable(
      '/r/bundle/cordis.patch.yml',
      [
        { id: 'ok', name: '../dist/providers/env-credentials.js' },
        { id: 'bare', name: '@deepseek-ai/dsh-tool-fs' },
        { id: 'disabled-only', disabled: true },
      ],
      exists,
    ),
  );
});

test('真实的 bundle/cordis.patch.yml 全部可解析', async () => {
  const { existsSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { loadOverlayPatches } = await import('@deepseek-ai/dsh-app-boot');
  const here = dirname(fileURLToPath(import.meta.url));
  const overlayFile = join(here, '../../src/runtime/bundle/cordis.patch.yml');
  const entries = loadOverlayPatches('pi-runtime', overlayFile);
  // 这条守的是"自建插件真的装得上"。它红过一次：credentials 与
  // subagent-spawn-in-process 曾指向 ../src/*.js（源码是 .ts），于是
  // ctx.credentials 静默退回出厂的 LocalCredentialProvider。
  assert.doesNotThrow(() => assertOverlayPatchResolvable(overlayFile, entries, existsSync));
});

// ── 组合断言（ADR 0007 验证要求 #2：断言组合结果，不是断言配置意图）──────
//
// 上面那条 YAML 断言在整个 2026-08 期间都是绿的，而 `ctx.credentials` 实际是出厂的
// `LocalCredentialProvider`——ADR 0007「必须从出厂组合中移除的行」点名不得组合的
// 那个。原因是 patch 里在已有行上改 `name`，被 dsh-app-boot 当作断言不匹配静默跳过。
// 断言 YAML 写了什么，永远发现不了这类问题。

test('boot 之后实际挂载的是自建实现，不是出厂实现', () => {
  // 子进程跑：boot 起的插件树没有 dispose 接口，留在本进程会让 node:test 挂住。
  const probe = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/boot-composition-probe.ts');
  const out = execFileSync('npx', ['tsx', probe], {
    encoding: 'utf8',
    cwd: join(dirname(fileURLToPath(import.meta.url)), '..'),
    // boot 现在按 MCP_SERVERS_JSON 叠插件。组合断言要的是 host 工具面，
    // 不能被开发机 .env 里的 Exa 等服务器拖进网络或改工具名单。
    env: { ...process.env, MCP_SERVERS_JSON: '[]' },
  });
  const mounted = JSON.parse(out.trim().split('\n').pop() as string) as {
    credentials: string | null;
    fs: string | null;
    shell: string | null;
    jobs: string | null;
    spawnProvider: { inheritsParentContext: boolean; capabilities: unknown } | null;
    toolNames: string[] | null;
    badSchemas: string[];
    seams: {
      approval: boolean;
      permissionPresets: boolean;
      userQuestions: boolean;
      subprocess: boolean;
    };
  };

  // 凭据：必须是我们的只读 env 实现。出厂的 LocalCredentialProvider 没有租户维度
  // 且热重载设置文件，多租户下是配置漂移面（ADR 0007「必须移除的行」）。
  assert.equal(mounted.credentials, 'EnvCredentialsProvider');

  // fs / shell / jobs：本机执行族全部关闭，只剩 RPC 代理。
  assert.equal(mounted.fs, 'RemoteFileSystem');
  assert.equal(mounted.shell, 'RemoteShell');
  assert.equal(mounted.jobs, 'RemoteJobs');

  // 子 Agent：`spawn` 名下必须是我们的 durable provider——用它声明的 capabilities
  // 组合识别，出厂的 spawn-in-process 声明的不是这一组。
  assert.ok(mounted.spawnProvider, 'provider "spawn" 必须注册');
  assert.equal(mounted.spawnProvider.inheritsParentContext, false);
  assert.deepEqual(mounted.spawnProvider.capabilities, {
    outputSchema: false,
    depthLimit: true,
    toolFilter: false,
    persona: false,
  });

  // ── 模型可见的工具面（ADR 0009 D3/D4，计划 H2.7）────────────────────────
  //
  // **断言恰好相等，不是「包含」。** 用「包含」抓不到「多出来一个」，而多出来
  // 正是 2026-08-31 起栈实测撞到的事故形状：dsh-base 里 8 个工具（web_search /
  // workflow / ralph / subagent_fork / subagent-control 三件 / goal 三件 /
  // exit_plan_mode / str_replace_editor）本来就是激活的，patch 里一个字都没提，
  // 所以上面那些 YAML 字符串断言永远抓不到它们。而分类器 fail-closed：
  // 模型看得见、一调必被拒。上游升级后新塞进来一个工具，这条会红。
  assert.notEqual(mounted.toolNames, null, 'ctx.tools 必须挂上');
  const all = mounted.toolNames ?? [];
  // MCP 工具是**部署配置**（`MCP_SERVERS_JSON` → 每台服务器一个
  // `dsh-mcp-client` 实例），永远不在 `ENTERPRISE_DEFAULT_TOOLS` 这份**固定**
  // 名单里。拿全集去比是错的——任何配了 MCP 的部署都会让这条红。
  // 2026-08-31 H7.8 起真实 MCP 服务器时才撞出来。
  //
  // 「恰好相等」的用意（抓上游 dsh-base 新塞进一个工具）对**host 工具面**保留；
  // MCP 那部分只断言命名形状。
  const actual = new Set(all.filter((n) => !n.startsWith('mcp__')));
  const expected = new Set<string>(ENTERPRISE_DEFAULT_TOOLS);
  for (const name of all.filter((n) => n.startsWith('mcp__'))) {
    assert.match(
      name,
      /^mcp__[A-Za-z0-9_-]{1,32}__.+$/,
      `MCP 工具必须是 mcp__<serverName>__<rawName> 形状：${name}`,
    );
  }
  assert.deepEqual(
    [...actual].filter((n) => !expected.has(n)).sort(),
    [],
    '注册表里多出风险表不认识的工具（fail-closed → 一调必被拒）：' +
      '要么在 manifest.ts 里 disable 掉，要么加进 runtime/policy/tool-names.ts',
  );
  assert.deepEqual(
    [...expected].filter((n) => !actual.has(n)).sort(),
    [],
    '名单里的工具 boot 之后不存在：多半是缺依赖或 patch 里没有对应 insert' +
      '——不要靠加 preset 绕过（ADR 0009 D3）',
  );

  // 每个工具的 `parameters` 必须是合法的 object 节点。2026-08-31 的 compose
  // 端到端第一次开 Run 就撞上：自建 `remote-fs-search` 把 `parameters` 抄成了
  // 出厂 `defineTool()` 的简写，注册成功、名字也在，但模型提供方拒
  // "Invalid schema for function 'glob'"，**整个 Run 失败**。
  // 断言名字在不在，抓不到这类错误。
  assert.deepEqual(
    mounted.badSchemas,
    [],
    '这些工具的 parameters 不是合法 object 节点——注册得进去，但开一轮就会被模型提供方拒',
  );

  // ── seam（ADR 0009 D5/D8）────────────────────────────────────────────────
  assert.equal(mounted.seams.approval, true, 'ctx.approval 必须打开（D5 改写了 ADR 0007 D4）');
  assert.equal(
    mounted.seams.permissionPresets,
    false,
    'dsh-permission-presets 是 process-level、无租户维度的产品级旋钮，不得组合',
  );
  assert.equal(mounted.seams.userQuestions, true);
  assert.equal(
    mounted.seams.subprocess,
    false,
    '本机 subprocess 不得为了 tool-fs-search 恢复（ADR 0009 D8 的「拒绝」条）',
  );
});
