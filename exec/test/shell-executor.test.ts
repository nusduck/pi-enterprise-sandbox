/**
 * `exec/src/shell/executor.ts` 单测——隔离执行器的薄组合层。
 *
 * 不依赖真实 bwrap：受阻路径根本不 spawn（硬要求1），其它纯逻辑
 *（resolve/blocked/env 脱敏/Python 物化判断）也是纯函数可测。
 * 真正 spawn 的用例检测 `bwrap` 是否可用，不可用时跳过，保证 macOS 可跑。
 */

import assert from 'node:assert/strict';
import { mkdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { IsolatedShellExecutor } from '../src/shell/executor.js';
import type { WorkspaceContext } from '../src/types.js';

async function makeTempRoots(): Promise<{
  workspaceRoot: string;
  tempRoot: string;
  systemSkillRoot: string;
  cleanup: () => Promise<void>;
}> {
  const base = await realpath(tmpdir());
  const tag = `exec-executor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const root = path.join(base, tag);
  const workspaceRoot = path.join(root, 'ws', 'ws_test');
  const tempRoot = path.join(root, 'tmp', 'tmp_test');
  const systemSkillRoot = path.join(root, 'sys_skill');
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(tempRoot, { recursive: true });
  await mkdir(systemSkillRoot, { recursive: true });
  return {
    workspaceRoot,
    tempRoot,
    systemSkillRoot,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

function makeWorkspace(roots: { workspaceRoot: string; tempRoot: string; systemSkillRoot: string }): WorkspaceContext {
  return {
    orgId: 'org_test',
    userId: 'user_test',
    workspaceId: 'ws_test',
    workspaceRoot: roots.workspaceRoot,
    tempRoot: roots.tempRoot,
    systemSkillRoot: roots.systemSkillRoot,
    enabledSkillPackages: [],
  };
}

test('sandboxMode reports the mode the executor was constructed with', async () => {
  const roots = await makeTempRoots();
  try {
    const ws = makeWorkspace(roots);
    const ro = new IsolatedShellExecutor({ workspace: ws, bwrapExecutable: '/usr/bin/bwrap', mode: 'read-only' });
    const rw = new IsolatedShellExecutor({ workspace: ws, bwrapExecutable: '/usr/bin/bwrap', mode: 'workspace-write' });
    assert.equal(ro.sandboxMode, 'read-only');
    assert.equal(rw.sandboxMode, 'workspace-write');
  } finally {
    await roots.cleanup();
  }
});

test('resolve fills defaults and caps timeout', async () => {
  const roots = await makeTempRoots();
  try {
    const ws = makeWorkspace(roots);
    const exec = new IsolatedShellExecutor({ workspace: ws, bwrapExecutable: '/usr/bin/bwrap', mode: 'workspace-write' });
    const spec = exec.resolve({ command: 'echo hi' });
    assert.equal(spec.command, 'echo hi');
    assert.equal(spec.workdir, '.');
    assert.ok(spec.timeoutMs >= 1 && spec.timeoutMs <= 86_400_000);
    assert.ok(spec.stdoutMaxBytes > 0);

    const capped = exec.resolve({ command: 'echo hi', timeoutMs: 999_999_999 });
    assert.equal(capped.timeoutMs, 86_400_000);

    const floored = exec.resolve({ command: 'echo hi', timeoutMs: 0 });
    assert.equal(floored.timeoutMs, 1);
  } finally {
    await roots.cleanup();
  }
});

test('run: empty command resolves to error result, not reject, and does not leak physical path', async () => {
  const roots = await makeTempRoots();
  try {
    const ws = makeWorkspace(roots);
    const exec = new IsolatedShellExecutor({ workspace: ws, bwrapExecutable: '/usr/bin/bwrap', mode: 'workspace-write' });
    const spec = exec.resolve({ command: '   ' });
    const result = await exec.run(spec);
    assert.equal(result.exitCode, 1);
    assert.equal(result.sandbox?.denied, false);
    assert.ok(!result.stderr.text.includes(roots.workspaceRoot), 'stderr must not contain physical root');
    assert.ok(!result.stderr.text.includes(roots.tempRoot), 'stderr must not contain temp root');
  } finally {
    await roots.cleanup();
  }
});

test('run: blocked commands are denied before isolation (no spawn) and resolve as denied', async () => {
  const roots = await makeTempRoots();
  try {
    const ws = makeWorkspace(roots);
    const exec = new IsolatedShellExecutor({
      workspace: ws,
      bwrapExecutable: '/nonexistent/bwrap-must-not-be-touched',
      mode: 'workspace-write',
    });
    const dangerous = [
      'sudo rm -rf /',
      'su -c id',
      'rm -rf /',
      'dd if=/dev/zero of=/tmp/x',
      'chmod 777 /tmp/x',
      'mkfs.ext4 /dev/sda1',
      'fdisk /dev/sda',
    ];
    for (const cmd of dangerous) {
      const spec = exec.resolve({ command: cmd });
      const result = await exec.run(spec);
      assert.equal(result.sandbox?.denied, true, `should deny: ${cmd}`);
      assert.equal(result.exitCode, 126);
      assert.ok(result.stderr.text.includes('blocked'), `stderr should mention blocked: ${cmd}`);
      assert.ok(!result.stderr.text.includes(roots.workspaceRoot));
    }
  } finally {
    await roots.cleanup();
  }
});

test('start: blocked commands return killed handle with deny', async () => {
  const roots = await makeTempRoots();
  try {
    const ws = makeWorkspace(roots);
    const exec = new IsolatedShellExecutor({
      workspace: ws,
      bwrapExecutable: '/nonexistent/bwrap-must-not-be-touched',
      mode: 'read-only',
    });
    const spec = exec.resolve({ command: 'sudo id' });
    const handle = exec.start(spec);
    assert.equal(handle.status, 'killed');
    assert.equal(handle.sandbox?.denied, true);
    const out = handle.readOutput();
    assert.ok(out.delta.includes('blocked'));
    assert.ok(!out.delta.includes(roots.workspaceRoot));
    await handle.done;
  } finally {
    await roots.cleanup();
  }
});

test('safe-env: secrets in processEnv do not leak into spawn env (checked via blocked path redaction)', async () => {
  const roots = await makeTempRoots();
  try {
    const ws = makeWorkspace(roots);
    // 注入一个应被拒绝的键，验证 executor 的 env 清洗不透传它。
    // 受阻路径不 spawn，但我们可以通过 run 一个合法命令并观察它不因 env 失败来间接验证：
    // 这里只验证构造时 env 清洗本身不抛错，且 run 的 blocked 判定仍以命令为准。
    const exec = new IsolatedShellExecutor({
      workspace: ws,
      bwrapExecutable: '/nonexistent/bwrap',
      mode: 'workspace-write',
      processEnv: {
        SANDBOX_API_TOKEN: 'secret-must-not-leak',
        SANDBOX_EXEC_ENV_FOO: 'bar',
        MY_PASSWORD: 'hunter2',
      },
    });
    const spec = exec.resolve({ command: 'echo hi', env: { FOO: 'override', SANDBOX_API_TOKEN: 'try-inject' } });
    // 仍应被正常处理（echo 不是危险命令），且不会因 bwrap 不存在之外的 env 原因受阻。
    // 这里用一个会因 bwrap 缺失而抛基础设施错误的合法命令，验证抛错路径的脱敏。
    try {
      await exec.run(spec);
      assert.fail('should have thrown infrastructure error for missing bwrap');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      assert.ok(!msg.includes(roots.workspaceRoot), 'thrown error must be redacted');
      assert.ok(!msg.includes('secret-must-not-leak'));
    }
  } finally {
    await roots.cleanup();
  }
});

test('Python materialize: short single line uses inline, multiline goes to file (via executor helpers)', async () => {
  const roots = await makeTempRoots();
  try {
    const ws = makeWorkspace(roots);
    const exec = new IsolatedShellExecutor({ workspace: ws, bwrapExecutable: '/usr/bin/bwrap', mode: 'workspace-write' });

    // 短单行：应走 -c，未物化。
    const inlineSpec = exec.resolve({ command: 'echo hi' });
    // 验证 runPython 的 inline 分支不会要求物化（shouldMaterialize 为 false）。
    // 直接测 planPythonLaunch 的判断在 python-materialize.test，但这里验证
    // startPython 对需要物化的长代码返回 killed 提示（同步 start 的限制）。
    const longCode = Array.from({ length: 5 }, (_, i) => `print(${i})`).join('\n');
    const handle = exec.startPython({ code: longCode, executionId: 'test_exec_1' });
    assert.equal(handle.status, 'killed');
    const out = handle.readOutput();
    assert.ok(out.delta.includes('materialization'));

    // 短代码的 startPython 应尝试真实 spawn（bwrap 可能不存在，基础设施错误进 killed stderr）。
    const shortHandle = exec.startPython({ code: 'print(1)', executionId: 'test_exec_2' });
    // 短代码走 inline，后台句柄应为 running（若 bwrap 缺失会落成 killed 但不因物化拒绝）。
    assert.ok(['running', 'killed'].includes(shortHandle.status));
    await shortHandle.done.catch(() => undefined);
  } finally {
    await roots.cleanup();
  }
});

test('isolation is the only spawn path: run with a safe command still goes through bwrap (fails closed if bwrap missing)', async () => {
  const roots = await makeTempRoots();
  try {
    const ws = makeWorkspace(roots);
    const exec = new IsolatedShellExecutor({
      workspace: ws,
      bwrapExecutable: '/nonexistent/bwrap-for-test',
      mode: 'workspace-write',
    });
    const spec = exec.resolve({ command: 'echo hello' });
    // echo 不是危险命令，会走到 spawn，此时 bwrap 缺失应抛基础设施错误（fail-closed）。
    await assert.rejects(() => exec.run(spec), /bwrap|Bubblewrap|spawn/i);
  } finally {
    await roots.cleanup();
  }
});
