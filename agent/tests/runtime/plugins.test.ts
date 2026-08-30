/**
 * 插件清单是唯一事实源，`bundle/cordis.patch.yml` 由它生成。
 *
 * 这一层存在的理由是 2026-08-30 那两次事故：patch 能静默写错，而写错时**没有
 * 任何人报错**——插件装不上就是出厂实现留在原位。所以这里断言的是
 * "清单与文件不会漂移" + "清单写不出那两种错误形状"。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { PLUGIN_MANIFEST, ownModulePaths, type PatchEntry } from '../../src/runtime/plugins/manifest.js';
import { renderPatchYaml } from '../../src/runtime/plugins/render.js';

const here = dirname(fileURLToPath(import.meta.url));
const patchPath = join(here, '../../src/runtime/bundle/cordis.patch.yml');

test('仓库里的 cordis.patch.yml 与清单生成结果逐字节一致', () => {
  const onDisk = readFileSync(patchPath, 'utf8');
  assert.equal(
    onDisk,
    renderPatchYaml(),
    '手改了 bundle/cordis.patch.yml，或改了 manifest.ts 却没跑 `npm run gen:patch`',
  );
});

test('没有任何条目用"改 name"的方式替换出厂插件', () => {
  // dsh-app-boot：`if (name && name !== target.name) { warn("name mismatch … skipping") }`
  // ——在已有行上改 name 会让整条 patch 被静默跳过。替换只能是
  // "disabled 出厂行 + insert 自建行"，manifest 的 replaceFactory() 强制这一点。
  const offenders: string[] = [];
  for (const entry of PLUGIN_MANIFEST) {
    if (entry.insert !== undefined) continue; // insert 里的 name 是新行，合法
    if (entry.id !== undefined && entry.name !== undefined) {
      offenders.push(`${entry.id} → ${entry.name}`);
    }
  }
  assert.deepEqual(offenders, [], '顶层条目不得同时带 id 与 name');
});

test('自建插件一律指向 patch 同树的 providers/，不指向别处', () => {
  // 原始 bug 是 name 写成了 `../src/providers/*.js`（源码是 .ts，文件不存在），
  // 插件于是静默退回出厂实现。阶段 F 之后 patch 与 provider 同在
  // `<out>/runtime/` 下，所以正确形态是 `../providers/`——任何别的前缀都
  // 意味着指到了源码目录或别的包。
  for (const path of ownModulePaths()) {
    assert.ok(path.startsWith('../providers/'), `${path} 必须是 ../providers/ 下`);
    assert.ok(!path.includes('/src/'), `${path} 不得指向 src/`);
  }
  assert.ok(ownModulePaths().length >= 5, '至少 5 个自建插件（credentials/subagent/fs/shell/jobs）');
});

test('每个被替换的出厂插件都同时有 disabled 行与 insert 行', () => {
  const disabled = new Set(
    PLUGIN_MANIFEST.filter((e) => e.disabled === true && e.id !== undefined).map((e) => e.id as string),
  );
  const insertedIds = new Set<string>();
  const visit = (e: PatchEntry): void => {
    for (const child of e.insert ?? []) {
      if (child.id !== undefined) insertedIds.add(child.id);
      visit(child);
    }
  };
  for (const e of PLUGIN_MANIFEST) visit(e);

  // credentials 与 subagent-spawn-in-process 是被替换的两个：出厂行必须关掉，
  // 自建行必须插入。只做其中一半就是当前生产状态里那两个 bug 之一。
  assert.ok(disabled.has('credentials'), '出厂 credentials 必须 disabled');
  assert.ok(insertedIds.has('enterprise-credentials'), '自建凭据必须 insert');
  assert.ok(disabled.has('subagent-spawn-in-process'), '出厂 subagent 必须 disabled');
  assert.ok(insertedIds.has('enterprise-durable-subagent'), '自建 durable subagent 必须 insert');
});

test('本机执行族全部关闭（ADR 0007 D11：Bubblewrap 在 exec 进程里）', () => {
  const disabled = new Set(
    PLUGIN_MANIFEST.filter((e) => e.disabled === true && e.id !== undefined).map((e) => e.id as string),
  );
  for (const id of [
    'sandbox',
    'sandbox-policy',
    'bash-sandbox',
    'pwsh-sandbox',
    'fs-sandbox',
    'subprocess',
    'jobs',
    'tool-pwsh',
    'tool-fs-search',
    'approval',
    'permission',
    'session-persistence-jsonl',
    'session-checkpoint-policy',
    'session-query-sqlite',
  ]) {
    assert.ok(disabled.has(id), `${id} 必须 disabled`);
  }
});

test('新增一个自建插件只需要改 manifest 一处', () => {
  // 用清单的公开构件模拟一次新增：把新条目喂给渲染器，输出里应当出现它，
  // 且不需要碰渲染器、boot、或 YAML 本身。
  const extended: PatchEntry[] = [
    ...PLUGIN_MANIFEST,
    { insert: [{ id: 'demo-plugin', name: '../providers/demo.js', config: {} }] },
  ];
  const yaml = renderPatchYaml(extended);
  assert.match(yaml, /id: demo-plugin/);
  assert.match(yaml, /'\.\.\/providers\/demo\.js'/);
});
