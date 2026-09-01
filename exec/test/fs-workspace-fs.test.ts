/**
 * `WorkspaceFileSystem` 集成测试——用真实临时目录跑，因为围栏的核心是
 * "realpath 之后落在哪个物理根里"，字符串层面的规则已经在
 * `fs-path-policy.test.ts` 覆盖过了。
 *
 * 覆盖来源：
 * - Python 版 `tests/test_path_validation.py`（既有安全性质，一条不减）
 * - ADR 0008 验证要求 #3（targetKey 稳定性）、#4（版本守卫/createIfAbsent 竞态）、
 *   #6（新增 lstat 符号链接拒绝用例）、#7（错误脱敏）
 */
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { FsError, FsTargetKey, type FsTarget } from '@deepseek-ai/dsh-fs';
import type { WorkspaceContext } from '../src/types.js';
import { WorkspaceFileSystem } from '../src/fs/workspace-fs.js';

interface Fixture {
  readonly root: string;
  readonly workspace: WorkspaceContext;
  readonly fs: WorkspaceFileSystem;
}

async function makeFixture(): Promise<Fixture> {
  // `os.tmpdir()` 在 macOS 上是 `/var/folders/...`，而 `/var` 本身是指向
  // `/private/var` 的符号链接——`WorkspaceFileSystem` 的 containment 检查
  // 一律走 realpath 比较（这正是 ADR 0008 验证要求 #3 targetKey 稳定性想要
  // 的行为），所以这里先把根目录本身 realpath 一次，让测试期望值天然就是
  // 规范形式，不用在每条断言里都重新 realpath 一遍。
  const rawRoot = await mkdtemp(path.join(tmpdir(), 'pi-exec-workspace-fs-'));
  const root = await realpath(rawRoot);
  const workspaceRoot = path.join(root, 'workspace');
  const tempRoot = path.join(root, 'temp');
  const systemSkillRoot = path.join(root, 'skill');
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(tempRoot, { recursive: true });
  await mkdir(systemSkillRoot, { recursive: true });

  const workspace: WorkspaceContext = {
    orgId: 'org1',
    userId: 'user1',
    workspaceId: 'ws1',
    workspaceRoot,
    tempRoot,
    systemSkillRoot,
    enabledSkillPackages: [],
  };

  const ctx = new Context();
  const fs = new WorkspaceFileSystem(ctx, workspace);
  return { root, workspace, fs };
}

async function cleanup(fixture: Fixture): Promise<void> {
  await rm(fixture.root, { recursive: true, force: true });
}

function assertDenied(fn: () => Promise<unknown>): Promise<void> {
  return assert.rejects(fn, (err: unknown) => {
    assert.ok(err instanceof FsError, 'expected an FsError');
    assert.equal((err as FsError).code, 'FS_SANDBOX_DENIED');
    return true;
  });
}

describe('WorkspaceFileSystem.resolve — 既有路径校验规则（移植自 test_path_validation.py）', () => {
  let fx!: Fixture;
  before(async () => {
    fx = await makeFixture();
  });
  after(() => cleanup(fx));

  test('basic relative resolution', async () => {
    const target = await fx.fs.resolve('myfile.txt');
    assert.equal(target.displayPath, 'myfile.txt');
    assert.equal(target.targetKey, path.join(fx.workspace.workspaceRoot, 'myfile.txt'));
  });

  test('subdirectory resolution', async () => {
    await mkdir(path.join(fx.workspace.workspaceRoot, 'sub'), { recursive: true });
    const target = await fx.fs.resolve('sub/file.txt');
    assert.equal(target.targetKey, path.join(fx.workspace.workspaceRoot, 'sub', 'file.txt'));
  });

  test('"." addresses the workspace root', async () => {
    const target = await fx.fs.resolve('.');
    assert.equal(target.displayPath, '.');
    // 夹具的 workspaceRoot 已经在 makeFixture() 里 realpath 过一次，直接比较即可。
    assert.equal(target.targetKey, fx.workspace.workspaceRoot);
  });

  test('rejects ".." traversal', async () => {
    await assertDenied(() => fx.fs.resolve('../etc/passwd'));
    await assertDenied(() => fx.fs.resolve('sub/../../outside.txt'));
  });

  test('rejects an absolute path outside the sandbox roots', async () => {
    await assertDenied(() => fx.fs.resolve('/etc/passwd'));
  });

  test('the legacy logical workspace absolute path is normalized', async () => {
    const target = await fx.fs.resolve('/home/sandbox/workspace/notes/a.txt');
    assert.equal(target.targetKey, path.join(fx.workspace.workspaceRoot, 'notes', 'a.txt'));
    const root = await fx.fs.resolve('/home/sandbox/workspace');
    assert.equal(root.displayPath, '.');
  });

  test('the persistent temp absolute path uses the temp root', async () => {
    const target = await fx.fs.resolve('/tmp/cache/a.txt');
    assert.equal(target.targetKey, path.join(fx.workspace.tempRoot, 'cache', 'a.txt'));
    assert.equal(target.displayPath, '/tmp/cache/a.txt');
  });

  test('other absolute roots are rejected', async () => {
    for (const p of ['/etc/passwd', '/var/sandbox/workspaces/x', '/home/sandbox/not-a-root/x']) {
      await assertDenied(() => fx.fs.resolve(p));
    }
  });

  test('system skill files are readable via the logical /home/sandbox/skill prefix', async () => {
    await writeFile(path.join(fx.workspace.systemSkillRoot, 'README.md'), '# skills\n');
    const target = await fx.fs.resolve('/home/sandbox/skill/README.md');
    assert.equal(target.displayPath, '/home/sandbox/skill/README.md');
    assert.equal(target.targetKey, path.join(fx.workspace.systemSkillRoot, 'README.md'));
    const text = await fx.fs.readText(target);
    assert.equal(text, '# skills\n');
  });

  test('system skill files are not writable', async () => {
    const target = await fx.fs.resolve('/home/sandbox/skill/README.md');
    await assertDenied(() => fx.fs.writeText(target, 'nope'));
  });

  test('deeply nested relative paths resolve correctly', async () => {
    await mkdir(path.join(fx.workspace.workspaceRoot, 'a', 'b', 'c'), { recursive: true });
    const target = await fx.fs.resolve('a/b/c/deep.txt');
    assert.equal(target.targetKey, path.join(fx.workspace.workspaceRoot, 'a', 'b', 'c', 'deep.txt'));
  });

  test('".." in the middle of a path is rejected', async () => {
    await mkdir(path.join(fx.workspace.workspaceRoot, 'sub2'), { recursive: true });
    await assertDenied(() => fx.fs.resolve('sub2/../outside.txt'));
  });

  test('symlink traversal outside the workspace is blocked', async () => {
    const outside = path.join(fx.root, 'outside_file.txt');
    await writeFile(outside, 'secret');
    const link = path.join(fx.workspace.workspaceRoot, 'evil_link');
    await symlink(outside, link);
    await assertDenied(() => fx.fs.resolve('evil_link'));
  });

  test('error text never leaks the physical workspace root', async () => {
    await assert.rejects(fx.fs.resolve('../escape.txt'), (err: unknown) => {
      assert.ok(err instanceof FsError);
      const msg = (err as FsError).message;
      assert.ok(!msg.includes(fx.workspace.workspaceRoot));
      assert.ok(msg.includes('path escape detected'));
      return true;
    });
  });

  test('null byte rejected', async () => {
    await assertDenied(() => fx.fs.resolve('foo\0bar'));
  });

  test('home expansion rejected', async () => {
    await assertDenied(() => fx.fs.resolve('~/secret'));
  });
});

describe('WorkspaceFileSystem.resolve — targetKey 稳定性（ADR 0008 验证要求 #3）', () => {
  let fx!: Fixture;
  before(async () => {
    fx = await makeFixture();
    await mkdir(path.join(fx.workspace.workspaceRoot, 'notes'), { recursive: true });
    await writeFile(path.join(fx.workspace.workspaceRoot, 'notes', 'a.txt'), 'hello');
    await symlink(
      path.join(fx.workspace.workspaceRoot, 'notes', 'a.txt'),
      path.join(fx.workspace.workspaceRoot, 'link_to_a.txt'),
    );
  });
  after(() => cleanup(fx));

  test('relative / absolute / dotted / symlinked spellings share one targetKey', async () => {
    const viaRelative = await fx.fs.resolve('notes/a.txt');
    const viaDotted = await fx.fs.resolve('./notes/a.txt');
    const viaAbsolute = await fx.fs.resolve('/home/sandbox/workspace/notes/a.txt');
    const viaSymlink = await fx.fs.resolve('link_to_a.txt');

    assert.equal(viaRelative.targetKey, viaDotted.targetKey);
    assert.equal(viaRelative.targetKey, viaAbsolute.targetKey);
    assert.equal(viaRelative.targetKey, viaSymlink.targetKey);

    // displayPath 不需要跟着规范化——每种拼写各自展示自己被给定的形式，
    // 这跟 dsh-fs-local 自身"displayPath 是未解析的绝对路径"的约定一致，
    // 只是我们把它换成了逻辑路径版本。
    assert.equal(viaSymlink.displayPath, 'link_to_a.txt');
  });
});

describe('WorkspaceFileSystem.lstat', () => {
  let fx!: Fixture;
  before(async () => {
    fx = await makeFixture();
  });
  after(() => cleanup(fx));

  test('reports type "symlink" for an in-workspace symlink without following it', async () => {
    await writeFile(path.join(fx.workspace.workspaceRoot, 'real.txt'), 'hi');
    await symlink(
      path.join(fx.workspace.workspaceRoot, 'real.txt'),
      path.join(fx.workspace.workspaceRoot, 'alias.txt'),
    );
    const info = await fx.fs.lstat('alias.txt');
    assert.ok(info);
    assert.equal(info.type, 'symlink');
  });

  test('rejects a path whose intermediate directory symlinks outside the workspace', async () => {
    // 新用例（ADR 0008 验证要求 #6）：lstat 不跟随路径最后一段的符号链接，
    // 但路径中间的目录段仍可能是符号链接——这条链路必须单独校验，不能因为
    // "lstat 不 follow 最后一段" 就误以为路径中间也天然安全。
    const outsideDir = path.join(fx.root, 'outside-dir');
    await mkdir(outsideDir, { recursive: true });
    await writeFile(path.join(outsideDir, 'secret.txt'), 'nope');
    const linkDir = path.join(fx.workspace.workspaceRoot, 'escape-dir');
    await symlink(outsideDir, linkDir);

    await assertDenied(() => fx.fs.lstat('escape-dir/secret.txt'));
  });

  test('returns undefined for a missing path', async () => {
    const info = await fx.fs.lstat('does-not-exist.txt');
    assert.equal(info, undefined);
  });

  test('rejects escaping paths the same way resolve() does', async () => {
    await assertDenied(() => fx.fs.lstat('../etc/passwd'));
  });
});

describe('WorkspaceFileSystem — 写入前紧邻的 containment 复查', () => {
  let fx!: Fixture;
  before(async () => {
    fx = await makeFixture();
  });
  after(() => cleanup(fx));

  test('a fabricated target pointing outside the workspace is rejected at write time, not just at resolve time', async () => {
    // 模拟"调用方绕过 resolve() 直接拿一个 target 写入"的情况——写入前的
    // containment 复查必须独立起作用，不能只依赖 resolve() 那一次检查。
    const outside = path.join(fx.root, 'outside-write.txt');
    const forged: FsTarget = { targetKey: FsTargetKey(outside), displayPath: 'outside-write.txt' };
    await assertDenied(() => fx.fs.writeText(forged, 'pwned'));

    const exists = await readFile(outside, 'utf8').catch(() => null);
    assert.equal(exists, null, 'the write must not have happened');
  });
});

describe('WorkspaceFileSystem — 版本守卫与并发（ADR 0008 验证要求 #4）', () => {
  let fx!: Fixture;
  before(async () => {
    fx = await makeFixture();
  });
  after(() => cleanup(fx));

  test('replaceIfVersion rejects a stale version', async () => {
    const target = await fx.fs.resolve('versioned.txt');
    const first = await fx.fs.writeText(target, 'v1');
    await fx.fs.writeText(target, 'v2'); // 无条件覆盖一次，让 first.version 变陈旧

    await assert.rejects(
      fx.fs.writeText(target, 'v3', { kind: 'replaceIfVersion', version: first.version }),
      (err: unknown) => {
        assert.ok(err instanceof FsError);
        assert.equal((err as FsError).code, 'FS_STALE_VERSION');
        return true;
      },
    );
  });

  test('editText validates the version guard BEFORE literal matching', async () => {
    const target = await fx.fs.resolve('edit-target.txt');
    const created = await fx.fs.writeText(target, 'original content');
    await fx.fs.writeText(target, 'changed content'); // 让 created.version 变陈旧

    // oldString 根本不存在于当前内容里；如果版本检查晚于字面匹配，这里会报
    // FS_EDIT_NOT_FOUND。契约要求版本检查必须先发生，报 FS_STALE_VERSION。
    await assert.rejects(
      fx.fs.editText(
        target,
        { oldString: 'this string does not exist anywhere', newString: 'x', replaceAll: false },
        { version: created.version },
      ),
      (err: unknown) => {
        assert.ok(err instanceof FsError);
        assert.equal((err as FsError).code, 'FS_STALE_VERSION');
        return true;
      },
    );
  });

  test('createIfAbsent race: the first creator wins, the loser is rejected, content is never clobbered', async () => {
    const target = await fx.fs.resolve('race.txt');

    const results = await Promise.allSettled([
      fx.fs.writeText(target, 'from writer A', { kind: 'createIfAbsent' }),
      fx.fs.writeText(target, 'from writer B', { kind: 'createIfAbsent' }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'exactly one writer should have created the file');
    assert.equal(rejected.length, 1, 'the other writer must be rejected, not silently overwritten');

    const rejection = rejected[0] as PromiseRejectedResult;
    assert.ok(rejection.reason instanceof FsError);
    assert.equal((rejection.reason as FsError).code, 'FS_NOT_OBSERVED');

    const winner = (fulfilled[0] as PromiseFulfilledResult<{ after: string }>).value;
    const onDisk = await readFile(path.join(fx.workspace.workspaceRoot, 'race.txt'), 'utf8');
    assert.equal(onDisk, winner.after);
  });
});

describe('WorkspaceFileSystem — 错误脱敏（ADR 0008 验证要求 #7）', () => {
  let fx!: Fixture;
  before(async () => {
    fx = await makeFixture();
  });
  after(() => cleanup(fx));

  test('a permission-denied IO error never leaks the physical workspace or temp root', async () => {
    const dir = path.join(fx.workspace.workspaceRoot, 'locked-dir');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'inner.txt'), 'x');
    // 去掉目录的执行/写权限，制造一个真实的 EACCES（root 用户下这个测试会
    // 自然跳过——sudo/CI 里常见以 root 跑，这时权限位形同虚设）。
    if (process.getuid && process.getuid() === 0) {
      return;
    }
    // 先在目录还能访问的时候 resolve()，拿到已经 realpath 过的 target——
    // 这样接下来测的是 readText() 自己的 EACCES 脱敏，而不是被 resolve()
    // 自己的 EACCES（同样会脱敏，但那不是这条用例想覆盖的路径）抢先短路。
    const target = await fx.fs.resolve('locked-dir/inner.txt');
    await chmod(dir, 0o000);
    try {
      await assert.rejects(fx.fs.readText(target), (err: unknown) => {
        assert.ok(err instanceof FsError);
        const msg = (err as FsError).message;
        assert.ok(!msg.includes(fx.workspace.workspaceRoot), `leaked workspace root: ${msg}`);
        assert.ok(!msg.includes(fx.workspace.tempRoot), `leaked temp root: ${msg}`);
        return true;
      });
    } finally {
      await chmod(dir, 0o700);
    }
  });

  test('a bare non-FsError thrown by dsh-fs-local is still redacted (not just FsError instances)', async () => {
    // 这条不依赖权限位/uid，跨环境（包括以 root 跑的 CI）都能稳定复现同一个
    // 缺陷：dsh-fs-local 的 `resolveLocalTarget()` 只把 realpath() 抛出的
    // ENOENT 翻译成 FsError（走"缺失路径走祖先解析"这条分支），其它错误码
    // 一律原样朝外抛裸 Node Error——用一对互相指向的符号链接制造 ELOOP，
    // 稳定触发这条未翻译路径，而不用依赖 chmod/uid 这类环境相关的手段。
    const loopA = path.join(fx.workspace.workspaceRoot, 'loop-a');
    const loopB = path.join(fx.workspace.workspaceRoot, 'loop-b');
    await symlink(loopB, loopA);
    await symlink(loopA, loopB);

    await assert.rejects(fx.fs.resolve('loop-a'), (err: unknown) => {
      // guard() 必须把它重建成 FsError（顺带修好 dsh-fs-local 对 ctx.fs
      // 契约"failures throw FsError"的违反），而不是让裸 Error 穿透。
      assert.ok(err instanceof FsError, `expected FsError, got ${String(err)}`);
      assert.equal((err as FsError).code, 'FS_IO_ERROR');
      const msg = (err as FsError).message;
      assert.ok(!msg.includes(fx.workspace.workspaceRoot), `leaked workspace root: ${msg}`);
      return true;
    });
  });

  test('listDir on a missing directory does not leak the physical root either', async () => {
    const outsideButFabricated: FsTarget = {
      targetKey: FsTargetKey(path.join(fx.workspace.workspaceRoot, 'does', 'not', 'exist')),
      displayPath: 'does/not/exist',
    };
    await assert.rejects(fx.fs.listDir(outsideButFabricated), (err: unknown) => {
      assert.ok(err instanceof FsError);
      assert.ok(!(err as FsError).message.includes(fx.workspace.workspaceRoot));
      return true;
    });
  });

  test('a mid-stream error from streamText() is redacted too, not just errors from the initial call', async () => {
    // `streamText()` 自己返回的 Promise<AsyncIterable<string>> 几乎不会拒绝——
    // dsh-fs-local 的 streamWholeText() 是 async generator，调用它只是同步
    // 创建生成器对象，真正打开文件/读流要到第一次 `for await` 才执行。所以
    // 单纯包住"拿 iterable 那一步"的 guard() 盖不到这里：要制造一个"拿到
    // iterable 那一刻还没事、真正读的时候才失败"的场景——stat 只需要目录的
    // 可遍历权限，createReadStream 打开文件才需要文件自身的读权限，所以对
    // 文件本身（不是目录）chmod 0 能精确复现这个时序。
    if (process.getuid && process.getuid() === 0) {
      return;
    }
    const filePath = path.join(fx.workspace.workspaceRoot, 'stream-locked.txt');
    await writeFile(filePath, 'x'.repeat(1024));
    const target = await fx.fs.resolve('stream-locked.txt');
    await chmod(filePath, 0o000);
    try {
      const iterable = await fx.fs.streamText(target);
      await assert.rejects(
        (async () => {
          for await (const _chunk of iterable) {
            // 读到这里说明泄漏没有发生在"拿 iterable"这一步，而应该发生在
            // 迭代过程中——正常情况下第一次迭代就会因为 EACCES 失败，不会
            // 真的产出任何 chunk。
          }
        })(),
        (err: unknown) => {
          assert.ok(err instanceof FsError, `expected FsError, got ${String(err)}`);
          const msg = (err as FsError).message;
          assert.ok(!msg.includes(fx.workspace.workspaceRoot), `leaked workspace root: ${msg}`);
          return true;
        },
      );
    } finally {
      await chmod(filePath, 0o700);
    }
  });
});

describe('WorkspaceFileSystem — cwd 支持（DSH 契约里的 opts.cwd，Python 版没有对应概念）', () => {
  let fx!: Fixture;
  before(async () => {
    fx = await makeFixture();
    await mkdir(path.join(fx.workspace.workspaceRoot, 'sub'), { recursive: true });
  });
  after(() => cleanup(fx));

  test('a relative path resolves against a validated cwd override', async () => {
    const target = await fx.fs.resolve('file.txt', { cwd: 'sub' });
    assert.equal(target.targetKey, path.join(fx.workspace.workspaceRoot, 'sub', 'file.txt'));
  });

  test('an absolute path ignores cwd entirely', async () => {
    const target = await fx.fs.resolve('/tmp/x.txt', { cwd: 'sub' });
    assert.equal(target.targetKey, path.join(fx.workspace.tempRoot, 'x.txt'));
  });

  test('a malicious cwd is rejected just like any other path', async () => {
    await assertDenied(() => fx.fs.resolve('file.txt', { cwd: '../escape' }));
  });
});
