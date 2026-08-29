/**
 * `search/` 的单元测试——对照 `sandbox/services/file_search.py` 的行为。
 *
 * 路由层的语义用例（`semantic-gaps.test.ts`）只覆盖"能不能搜到"，这里补的是
 * 路由测不到的三类：**预算钳制**、**符号链接安全**、**不安全正则拒绝**。
 * 这三条是搜索面被悄悄改松时最先失守的地方。
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import {
  FileSearchService,
  SearchQueryError,
  compileGrepQuery,
  globMatches,
  isBinaryBytes,
  clampInt,
  type SearchRoot,
} from '../src/search/index.js';

describe('search: predicates', () => {
  test('isBinaryBytes: NUL 即二进制；空内容不是二进制', () => {
    assert.equal(isBinaryBytes(new Uint8Array([])), false, '空文件不该被当二进制跳过');
    assert.equal(isBinaryBytes(new Uint8Array([0x61, 0x00, 0x62])), true);
    assert.equal(isBinaryBytes(new Uint8Array([0x61, 0x62, 0x0a])), false);
  });

  test('isBinaryBytes: 非文本控制字节占比超 30% 判为二进制', () => {
    // 10 字节里 4 个 0x01 → 40% > 30%
    const mostlyControl = new Uint8Array([1, 1, 1, 1, 0x61, 0x62, 0x63, 0x64, 0x65, 0x66]);
    assert.equal(isBinaryBytes(mostlyControl), true);
    // ESC(27) 与 \t\n\r 属于文本，不计入
    const escapes = new Uint8Array([27, 9, 10, 13, 0x61, 0x62, 0x63, 0x64, 0x65, 0x66]);
    assert.equal(isBinaryBytes(escapes), false);
  });

  test('globMatches: 无斜杠匹配 basename，有斜杠匹配相对路径', () => {
    assert.equal(globMatches('*.md', 'a.md', 'deep/nested/a.md'), true, '朴素 pattern 匹配 basename');
    assert.equal(globMatches('*.md', 'a.txt', 'a.txt'), false);
    assert.equal(globMatches('src/*.ts', 'x.ts', 'src/x.ts'), true);
    assert.equal(globMatches('src/*.ts', 'x.ts', 'other/x.ts'), false, '带路径的 pattern 要限定目录');
    assert.equal(globMatches('/src/*.ts', 'x.ts', 'src/x.ts'), true, '开头的 / 被剥掉');
  });

  test('compileGrepQuery: 非 regex 时整串转义', () => {
    const re = compileGrepQuery('a.b', { regex: false, caseSensitive: true });
    assert.equal(re.test('a.b'), true);
    assert.equal(re.test('axb'), false, '字面量模式下 . 不能当通配符');
  });

  test('compileGrepQuery: 拒绝会灾难性回溯的构造', () => {
    for (const bad of ['(a+)+', '(?=x)', '.*.*.*', 'a{2,}']) {
      assert.throws(
        () => compileGrepQuery(bad, { regex: true, caseSensitive: true }),
        SearchQueryError,
        `${bad} 应当被拒绝`,
      );
    }
    // 正常正则仍然可用
    assert.ok(compileGrepQuery('^foo[0-9]+bar$', { regex: true, caseSensitive: true }));
  });

  test('clampInt: 只能收紧，非法输入取默认值', () => {
    assert.equal(clampInt(10 ** 9, 500, 1, 500), 500, '超出上限被夹住');
    assert.equal(clampInt(-5, 500, 1, 500), 1);
    assert.equal(clampInt('abc', 500, 1, 500), 500, '非法输入取默认而不是抛');
    assert.equal(clampInt(null, 500, 1, 500), 500);
    assert.equal(clampInt(42, 500, 1, 500), 42);
  });
});

describe('search: service', () => {
  let base: string;
  let root: string;
  let outside: string;
  const svc = new FileSearchService();
  const where = (): SearchRoot => ({ root, start: root, publicPrefix: null });

  before(async () => {
    const resolved = await realpath(tmpdir());
    base = await mkdtemp(path.join(resolved, 'pi-search-'));
    root = path.join(base, 'ws');
    outside = path.join(base, 'outside');
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    await mkdir(path.join(root, 'sub'), { recursive: true });

    await writeFile(path.join(root, 'a.txt'), 'alpha\nNEEDLE here\ngamma\n');
    await writeFile(path.join(root, 'sub', 'b.txt'), 'another NEEDLE\n');
    await writeFile(path.join(root, '.hidden'), 'NEEDLE hidden\n');
    await writeFile(path.join(outside, 'secret.txt'), 'NEEDLE secret\n');
    await symlink(path.join(outside, 'secret.txt'), path.join(root, 'escape.txt'));
    await symlink(outside, path.join(root, 'escape-dir'));
  });

  after(async () => {
    await rm(base, { recursive: true, force: true });
  });

  test('grep 不跟随指向工作区外的文件符号链接', async () => {
    const res = await svc.grep(where(), { query: 'NEEDLE' });
    const paths = res.matches.map((m) => m.path);
    assert.ok(!paths.includes('escape.txt'), '越界符号链接的内容绝不能出现在结果里');
    assert.ok(
      res.skipped.some((s) => s.path === 'escape.txt' && s.reason === 'symlink_escape'),
      '必须记为 symlink_escape，而不是静默消失',
    );
  });

  test('grep 不下降进符号链接目录', async () => {
    const res = await svc.grep(where(), { query: 'NEEDLE' });
    assert.ok(
      !res.matches.some((m) => m.path.startsWith('escape-dir/')),
      '符号链接目录里的内容不该被搜到',
    );
    assert.ok(
      res.skipped.some((s) => s.path === 'escape-dir' && s.reason === 'symlink_dir_skipped'),
    );
  });

  test('grep 返回行号与列号，按 path/line/column 稳定排序', async () => {
    const res = await svc.grep(where(), { query: 'NEEDLE' });
    const real = res.matches.filter((m) => m.path === 'a.txt' || m.path === 'sub/b.txt');
    assert.deepEqual(
      real.map((m) => [m.path, m.line, m.column]),
      [
        ['a.txt', 2, 1],
        ['sub/b.txt', 1, 9],
      ],
    );
  });

  test('grep limit 到顶时给出 truncated + stop_reason，而不是假装搜完了', async () => {
    const res = await svc.grep(where(), { query: 'NEEDLE', limit: 1 });
    assert.equal(res.matches.length, 1);
    assert.equal(res.truncated, true);
    assert.equal(res.stop_reason, 'match_limit');
  });

  test('grep context 带出前后文', async () => {
    const res = await svc.grep(where(), { query: 'NEEDLE', glob: 'a.txt', context: 1 });
    const m = res.matches[0];
    assert.ok(m);
    assert.deepEqual(m.before, ['alpha']);
    assert.deepEqual(m.after, ['gamma']);
  });

  test('grep 的 files_with_matches / count 模式不返回行文本', async () => {
    const fwm = await svc.grep(where(), { query: 'NEEDLE', outputMode: 'files_with_matches' });
    assert.ok(fwm.matches.every((m) => m.text === ''));
    const counted = await svc.grep(where(), { query: 'NEEDLE', glob: 'a.txt', outputMode: 'count' });
    assert.equal(counted.matches[0]?.count, 1);
  });

  test('find 按 type 过滤', async () => {
    const dirs = await svc.find(where(), { pattern: '*', type: 'dir' });
    assert.ok(dirs.items.every((i) => i.type === 'dir'));
    assert.ok(dirs.items.some((i) => i.path === 'sub'));
  });

  test('find 的 maxDepth 生效', async () => {
    const shallow = await svc.find(where(), { pattern: '*.txt', maxDepth: 1 });
    assert.ok(!shallow.items.some((i) => i.path === 'sub/b.txt'), 'depth 1 不该下到 sub/');
    const deep = await svc.find(where(), { pattern: '*.txt', maxDepth: 2 });
    assert.ok(deep.items.some((i) => i.path === 'sub/b.txt'));
  });

  test('ls 默认不列隐藏文件，include_hidden 才列', async () => {
    const plain = await svc.ls(where());
    assert.ok(!plain.items.some((i) => i.name === '.hidden'));
    const withHidden = await svc.ls(where(), { includeHidden: true });
    assert.ok(withHidden.items.some((i) => i.name === '.hidden'));
  });

  test('起点不存在时返回 not_found，而不是抛', async () => {
    const res = await svc.find({ root, start: path.join(root, 'nope'), publicPrefix: null });
    assert.equal(res.stop_reason, 'not_found');
    assert.deepEqual(res.items, []);
    assert.equal(res.skipped[0]?.reason, 'not_found');
  });

  test('结果里不出现物理根', async () => {
    const res = await svc.grep(where(), { query: 'NEEDLE' });
    const blob = JSON.stringify(res);
    assert.ok(!blob.includes(root), `物理根泄漏了: ${root}`);
    assert.ok(!blob.includes(base));
  });

  test('publicPrefix 为 /tmp 时结果路径带该前缀', async () => {
    const res = await svc.ls({ root, start: root, publicPrefix: '/tmp' });
    assert.ok(res.items.every((i) => i.path.startsWith('/tmp/')));
  });
});
