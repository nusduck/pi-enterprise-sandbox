/**
 * design §3.3 第 6 条：按账本构造的 Run 内 provider。
 *
 * 2026-09-14 真实链路复现：`skill` 工具给的基础目录是 Agent 本地
 * `<base>/<org>/<user>/<name>`，exec 把第一段当包名，`read` 被 FS_SANDBOX_DENIED。
 * 这里用出厂 FileSystemSkillProvider 做真实解析，断言对外只暴露 exec 的逻辑挂载路径。
 */
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import {
  createPublishedSkillsProvider,
  USER_SKILL_LOGICAL_ROOT,
} from '../../src/infrastructure/dsh/published-skills-provider.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

const ctx = {
  logger: { warn() {}, info() {}, debug() {}, error() {} },
  get: () => undefined,
};
const control = { signal: new AbortController().signal, invalidate() {} };

async function version(root: string, dirName: string, digest: string, frontmatterName: string, body: string) {
  const versionRoot = path.join(root, dirName, '.v', digest);
  const packageDir = path.join(versionRoot, dirName);
  await fsp.mkdir(path.join(packageDir, 'reference'), { recursive: true });
  await fsp.writeFile(
    path.join(packageDir, 'SKILL.md'),
    `---\nname: ${frontmatterName}\ndescription: probe\n---\n${body}\n`,
  );
  await fsp.writeFile(path.join(packageDir, 'reference', 'marker.txt'), 'marker\n');
  return { name: dirName, contentDigest: digest, versionRoot, packageDir };
}

async function withRoot(fn: (root: string) => Promise<void>) {
  const root = await fsp.mkdtemp(path.join(await fsp.realpath(tmpdir()), 'published-skills-'));
  try {
    await fn(root);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

function candidatesOf(listed: any): any[] {
  return Array.isArray(listed) ? listed : listed.candidates;
}

test('lists only the manifest versions and exposes the exec logical mount path', async () => {
  await withRoot(async (root) => {
    const alpha = await version(root, 'alpha', A, 'alpha', 'CURRENT body');
    await version(root, 'alpha', B, 'alpha', 'STALE body');
    const impostor = await version(root, 'beta', A, 'alpha', 'IMPOSTOR body');
    const provider = createPublishedSkillsProvider(ctx, control, [alpha, impostor]);

    const candidates = candidatesOf(await provider.list({ cwd: '/home/sandbox/workspace' }));
    assert.deepEqual(candidates.map((c) => c.name), ['alpha']);
    const [candidate] = candidates;
    assert.equal(candidate.path, `${USER_SKILL_LOGICAL_ROOT}/alpha/SKILL.md`);
    assert.deepEqual(candidate.resourceBase, { kind: 'directory', path: `${USER_SKILL_LOGICAL_ROOT}/alpha` });
    assert.equal(candidate.provider, 'run-published');

    const loaded = await provider.get(candidate, {});
    assert.ok(loaded, 'listed skill must load');
    assert.match(loaded.content, /CURRENT body/);
    assert.equal(loaded.path, `${USER_SKILL_LOGICAL_ROOT}/alpha/SKILL.md`);
    assert.deepEqual(loaded.resourceBase, { kind: 'directory', path: `${USER_SKILL_LOGICAL_ROOT}/alpha` });
    assert.equal(JSON.stringify({ path: loaded.path, resourceBase: loaded.resourceBase }).includes(root), false);
  });
});

test('get refuses a name that was not listed from this Run manifest', async () => {
  await withRoot(async (root) => {
    const alpha = await version(root, 'alpha', A, 'alpha', 'body');
    const provider = createPublishedSkillsProvider(ctx, control, [alpha]);
    await provider.list({ cwd: '/home/sandbox/workspace' });
    assert.equal(await provider.get({ name: 'beta' }, {}), undefined);
  });
});
