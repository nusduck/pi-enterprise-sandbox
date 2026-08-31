/**
 * ADR 0009 D7 / 计划 H6.4–H6.5：启用闸门与「复制字节」。
 *
 * 最关键的一条是 **H6.5**：已启用副本与草稿必须是**两份字节**。
 * 同一份字节意味着 ADR 0006 P1 (B) 点名的绕过还在——批准的是 A，
 * 运行的是模型随后改成的 B。
 */
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import {
  disableSkillPackage,
  enableDraftPackage,
  inspectDraftPackage,
} from '../src/skills/enablement.js';

async function scratch(): Promise<{ draft: string; published: string; cleanup: () => Promise<void> }> {
  const base = await fsp.mkdtemp(path.join(await fsp.realpath(tmpdir()), 'skill-enable-'));
  const draft = path.join(base, 'draft');
  const published = path.join(base, 'published');
  await fsp.mkdir(draft, { recursive: true });
  await fsp.mkdir(published, { recursive: true });
  return { draft, published, cleanup: () => fsp.rm(base, { recursive: true, force: true }) };
}

async function writeDraft(draft: string, name: string, body: string, extra: Record<string, string> = {}) {
  const dir = path.join(draft, name);
  await fsp.mkdir(path.join(dir, 'scripts'), { recursive: true });
  await fsp.writeFile(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: a test skill\n---\n\n${body}\n`,
    'utf8',
  );
  for (const [rel, content] of Object.entries(extra)) {
    const target = path.join(dir, rel);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, content, 'utf8');
  }
  return dir;
}

test('H6.5 启用是复制字节：改草稿动不了已启用副本', async () => {
  const ws = await scratch();
  try {
    const pkg = await writeDraft(ws.draft, 'demo', 'v1 body', { 'scripts/run.sh': 'echo v1\n' });
    const enabled = await enableDraftPackage({ draftPackageDir: pkg, publishedRoot: ws.published });

    const publishedScript = path.join(enabled.publishedPath, 'scripts/run.sh');
    assert.equal(await fsp.readFile(publishedScript, 'utf8'), 'echo v1\n');

    // 模型继续改草稿——已启用的那份必须纹丝不动。
    await fsp.writeFile(path.join(pkg, 'scripts/run.sh'), 'echo PWNED\n', 'utf8');
    assert.equal(
      await fsp.readFile(publishedScript, 'utf8'),
      'echo v1\n',
      '两份字节：这正是 ADR 0006 P1 (B) 的绕过被消掉的地方',
    );
  } finally {
    await ws.cleanup();
  }
});

test('H6.5 摘要绑内容不绑时间戳：同样的字节算出同一个值', async () => {
  const ws = await scratch();
  try {
    const a = await writeDraft(ws.draft, 'aaa', 'same', { 'scripts/x.sh': 'x\n' });
    const first = await inspectDraftPackage(a);
    // 重写同样的内容（mtime 变了），摘要必须不变。
    await fsp.writeFile(path.join(a, 'scripts/x.sh'), 'x\n', 'utf8');
    const second = await inspectDraftPackage(a);
    assert.equal(second.contentDigest, first.contentDigest);

    // 内容变一个字节，摘要必须变。
    await fsp.writeFile(path.join(a, 'scripts/x.sh'), 'y\n', 'utf8');
    assert.notEqual((await inspectDraftPackage(a)).contentDigest, first.contentDigest);
  } finally {
    await ws.cleanup();
  }
});

test('H6.4 结构校验复用既有实现：缺 SKILL.md / 名字对不上都拒', async () => {
  const ws = await scratch();
  try {
    const empty = path.join(ws.draft, 'nope');
    await fsp.mkdir(empty, { recursive: true });
    await assert.rejects(() => inspectDraftPackage(empty), /Missing SKILL\.md/);

    const pkg = await writeDraft(ws.draft, 'realname', 'b');
    await assert.rejects(
      () => inspectDraftPackage(pkg, 'othername'),
      /does not match package name/,
    );
  } finally {
    await ws.cleanup();
  }
});

test('H6.4 草稿根是模型可写的：符号链接与 VCS 元数据必须拒', async () => {
  const ws = await scratch();
  try {
    const pkg = await writeDraft(ws.draft, 'linky', 'b');
    await fsp.symlink('/etc/passwd', path.join(pkg, 'scripts/leak'));
    await assert.rejects(
      () => inspectDraftPackage(pkg),
      /symlink/,
      '一条指向 /etc 的链接会把宿主文件复制进已启用副本',
    );

    const pkg2 = await writeDraft(ws.draft, 'vcs', 'b');
    await fsp.mkdir(path.join(pkg2, '.git'), { recursive: true });
    await fsp.writeFile(path.join(pkg2, '.git/config'), 'x', 'utf8');
    await assert.rejects(() => inspectDraftPackage(pkg2), /VCS metadata/);
  } finally {
    await ws.cleanup();
  }
});

test('H6 停用删掉已发布副本，但**不动草稿**', async () => {
  const ws = await scratch();
  try {
    const pkg = await writeDraft(ws.draft, 'demo', 'v1');
    await enableDraftPackage({ draftPackageDir: pkg, publishedRoot: ws.published });

    assert.deepEqual(await disableSkillPackage({ publishedRoot: ws.published, name: 'demo' }), {
      removed: true,
    });
    assert.deepEqual(await fsp.readdir(ws.published), []);
    // 草稿还在：停用不是删除用户的工作成果，只是把它从模型上下文里拿走。
    assert.equal((await fsp.stat(pkg)).isDirectory(), true);

    // 幂等：停用一个没启用的包不该抛。
    assert.deepEqual(await disableSkillPackage({ publishedRoot: ws.published, name: 'demo' }), {
      removed: false,
    });
  } finally {
    await ws.cleanup();
  }
});

test('H6.5 重新启用是整份替换，不是叠加', async () => {
  const ws = await scratch();
  try {
    const pkg = await writeDraft(ws.draft, 'demo', 'v1', { 'scripts/old.sh': 'old\n' });
    const first = await enableDraftPackage({ draftPackageDir: pkg, publishedRoot: ws.published });
    assert.equal(first.fileCount, 2);

    await fsp.rm(path.join(pkg, 'scripts/old.sh'));
    await fsp.writeFile(path.join(pkg, 'scripts/new.sh'), 'new\n', 'utf8');
    const second = await enableDraftPackage({ draftPackageDir: pkg, publishedRoot: ws.published });

    const files = await fsp.readdir(path.join(second.publishedPath, 'scripts'));
    assert.deepEqual(files, ['new.sh'], '旧文件必须消失——叠加会让停用过的能力偷偷留着');
  } finally {
    await ws.cleanup();
  }
});

test('H6.13 启用不得遮蔽系统 skill（检查搬到启用这一刻，不是写草稿时）', async () => {
  const ws = await scratch();
  try {
    const pkg = await writeDraft(ws.draft, 'pdf', 'shadow attempt');

    // 草稿叫什么名字都可以——它不进任何人的上下文。
    await assert.doesNotReject(() => inspectDraftPackage(pkg));

    // 但启用会被拒：ADR 0009 D7 引的原话是「an installed skill must never be
    // able to shadow or overwrite one the platform vouches for」。
    await assert.rejects(
      () =>
        enableDraftPackage({
          draftPackageDir: pkg,
          publishedRoot: ws.published,
          systemSkillNames: ['pdf'],
        }),
      /bundled system Skill/,
    );
    assert.deepEqual(await fsp.readdir(ws.published), [], '被拒时不该留下半个副本');
  } finally {
    await ws.cleanup();
  }
});

// ── H6.7：上传与模型创建走同一条闸门 ───────────────────────────────────────

test('H6.7 上传解包进草稿根，不直接写已启用根', async () => {
  const ws = await scratch();
  const { createSkillManager } = await import('../src/skills/manager.js');
  const { createStoredZip } = await import('./support/stored-zip.js');

  const manager = createSkillManager({
    skillRoots: [path.join(ws.published, '..', 'system'), ws.published],
    userSkillRoot: ws.published,
    draftSkillRoot: ws.draft,
    downloadArchive: async () => {
      const zip = createStoredZip([
        {
          name: 'SKILL.md',
          content: '---\nname: uploaded\ndescription: from a zip\n---\n\nbody\n',
        },
      ]) as Buffer;
      const { createHash } = await import('node:crypto');
      return new Response(zip, {
        headers: {
          'content-type': 'application/zip',
          'content-length': String(zip.length),
          'x-dataset-sha256': createHash('sha256').update(zip).digest('hex'),
        },
      });
    },
  });

  await manager.install({ attachmentId: 'dataset-1', archiveName: 'uploaded.zip' });

  // 上传后**只**落在草稿里：闸门还没过，它不该进已启用根。
  assert.deepEqual(await fsp.readdir(ws.draft), ['uploaded']);
  assert.deepEqual(
    await fsp.readdir(ws.published),
    [],
    '上传绕过启用闸门的话，模型造的包必须经人启用、上传的包不必——两条路径语义就分叉了',
  );

  // 走同一条闸门之后才进已启用根。
  const record = await manager.enable({ name: 'uploaded' });
  assert.equal(record.name, 'uploaded');
  assert.deepEqual(await fsp.readdir(ws.published), ['uploaded']);

  await ws.cleanup();
});
