/**
 * 公共面 `DELETE /sessions/:sessionId`（会话工作区 GC）的合约测试。
 *
 * 背景：agent 删除/归档会话时调 `DELETE {SANDBOX_BASE_URL}/sessions/{id}`，
 * 但 exec 公共面只有 `/sessions/:id/files|processes|datasets` 子路由——请求必然
 * 失败，agent 侧 fail-soft 只打日志，工作区目录从不删除。本文件先行覆盖新路由
 * 的全部语义（TDD：实现前这些用例必须失败）。
 *
 * 全部在 macOS 可跑：真实 temp 根 + `InMemoryJobStore` + `InMemoryWorkspacePolicyStore`，
 * 不依赖真实 MySQL 或 bwrap。
 */

import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Hono } from 'hono';
import { WorkspaceManager } from '../src/workspace/manager.js';
import { createPublicRouter } from '../src/http/public/router.js';
import { InMemoryJobStore } from '../src/shell/job-store-memory.js';
import { MySqlJobRegistry } from '../src/shell/job-registry.js';
import { InMemoryWorkspacePolicyStore } from '../src/db/repositories/workspace-policies.js';
import { isTerminalJobStatus } from '../src/shell/job-types.js';

describe('public: DELETE /sessions/:sessionId (workspace GC)', () => {
  let base: string;
  let workspaceManager: WorkspaceManager;
  let jobRegistry: MySqlJobRegistry;
  let workspacePolicies: InMemoryWorkspacePolicyStore;
  let app: Hono;

  before(async () => {
    const resolved = await realpath(tmpdir());
    base = await mkdtemp(path.join(resolved, 'dsh-sess-del-'));
    workspaceManager = new WorkspaceManager({
      workspacesBaseRoot: path.join(base, 'workspaces'),
      tempBaseRoot: path.join(base, 'tmp'),
    });
    jobRegistry = new MySqlJobRegistry(new InMemoryJobStore());
    workspacePolicies = new InMemoryWorkspacePolicyStore();
    app = createPublicRouter({
      apiToken: null,
      workspaceManager,
      systemSkillRoot: path.join(base, 'skills'),
      enabledSkillPackagesFor: () => [],
      jobRegistry,
      workspacePolicies,
    });
    await mkdir(path.join(base, 'skills'), { recursive: true });
  });

  after(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const acting = {
    'x-acting-organization-id': 'org_test',
    'x-acting-user-id': 'user_test',
  };
  const otherActing = {
    'x-acting-organization-id': 'org_other',
    'x-acting-user-id': 'user_other',
  };

  async function exists(target: string): Promise<boolean> {
    try {
      await access(target);
      return true;
    } catch {
      return false;
    }
  }

  /** 可被 cancel 结束的可控假句柄：cancel 即按 killed 结算（复用 registry 现有终止路径）。 */
  function killableHandle() {
    let doneResolve: (o: { status: 'killed'; exitCode: null; signal: 'SIGTERM'; detail: string }) => void =
      () => {};
    const done = new Promise<{ status: 'killed'; exitCode: null; signal: 'SIGTERM'; detail: string }>(
      (res) => {
        doneResolve = res;
      },
    );
    return {
      pid: null as number | null,
      cancel() {
        doneResolve({ status: 'killed', exitCode: null, signal: 'SIGTERM', detail: 'killed: SIGTERM' });
      },
      done,
      readOutput() {
        return { delta: '', lossy: false as const };
      },
    };
  }

  test('本人删除 → 200 {removed:true}，工作区与配对 temp 都不存在', async () => {
    const id = 'pub_sessdel_own_1';
    await workspaceManager.initWorkspace(id);
    const ws = workspaceManager.physicalWorkspacePath(id);
    const tmp = workspaceManager.physicalTempPath(id);
    assert.equal(await exists(ws), true);
    assert.equal(await exists(tmp), true);

    const res = await app.request(`/sessions/${id}`, { method: 'DELETE', headers: acting });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { removed: true });
    assert.equal(await exists(ws), false);
    assert.equal(await exists(tmp), false);
  });

  test('重复删除 → 200 {removed:false}（幂等）', async () => {
    const id = 'pub_sessdel_repeat_1';
    await workspaceManager.initWorkspace(id);
    const first = await app.request(`/sessions/${id}`, { method: 'DELETE', headers: acting });
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { removed: true });
    const second = await app.request(`/sessions/${id}`, { method: 'DELETE', headers: acting });
    assert.equal(second.status, 200);
    assert.deepEqual(await second.json(), { removed: false });
  });

  test('从未创建的会话 → 200 {removed:false}，不是错误', async () => {
    const id = 'pub_sessdel_never_1';
    const res = await app.request(`/sessions/${id}`, { method: 'DELETE', headers: acting });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { removed: false });
  });

  test('无 acting → 404 且目录仍在（跨租户不泄漏存在性）', async () => {
    const id = 'pub_sessdel_noauth_1';
    await workspaceManager.initWorkspace(id);
    const ws = workspaceManager.physicalWorkspacePath(id);
    const res = await app.request(`/sessions/${id}`, { method: 'DELETE', headers: {} });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: string };
    assert.ok(!body.error.includes(base), `must be redacted: ${body.error}`);
    assert.equal(await exists(ws), true);
  });

  test('他人/他组织删除审核工作区 → 404 且目录仍在；本人删除 → removed:true', async () => {
    // 审核工作区的创建组织记在 workspace-policies（HMAC 内部面 ensure 时写入，
    // 只能设置不能撤销）：它是 exec 侧唯一能判定"这个工作区是谁的"的事实。
    const id = 'pub_sessdel_review_1';
    await workspaceManager.initWorkspace(id);
    await workspacePolicies.rememberReview(id, 'org_test');
    const ws = workspaceManager.physicalWorkspacePath(id);

    const foreign = await app.request(`/sessions/${id}`, { method: 'DELETE', headers: otherActing });
    assert.equal(foreign.status, 404);
    assert.equal(await exists(ws), true);

    const own = await app.request(`/sessions/${id}`, { method: 'DELETE', headers: acting });
    assert.equal(own.status, 200);
    assert.deepEqual(await own.json(), { removed: true });
    assert.equal(await exists(ws), false);
  });

  test('非法会话 id → 404（不拼接请求参数，不删别的目录）', async () => {
    const res = await app.request('/sessions/not%20valid%21%21', {
      method: 'DELETE',
      headers: acting,
    });
    assert.equal(res.status, 404);
  });

  test('有运行中后台作业时删除 → 作业进入终态，目录被删', async () => {
    const id = 'pub_sessdel_job_1';
    await workspaceManager.initWorkspace(id);
    const ws = workspaceManager.physicalWorkspacePath(id);
    const owner = {
      orgId: acting['x-acting-organization-id'],
      userId: acting['x-acting-user-id'],
      workspaceId: id,
    };
    const snap = await jobRegistry.start({
      kind: 'bash',
      label: 'sleep-forever',
      owner: { ...owner, runId: 'run_gc_1' },
      physicalRoots: [],
      run: () => killableHandle(),
    });
    assert.equal((await jobRegistry.get(snap.id, owner))?.status, 'running');

    const res = await app.request(`/sessions/${id}`, { method: 'DELETE', headers: acting });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { removed: true });
    assert.equal(await exists(ws), false);

    // kill 走 registry 现有终止路径（cancel → done 结算）；结算落到终态是异步的，这里轮询确认。
    const deadline = Date.now() + 5000;
    let status: string | undefined;
    for (;;) {
      status = (await jobRegistry.get(snap.id, owner))?.status;
      if ((status && isTerminalJobStatus(status as never)) || Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(status && isTerminalJobStatus(status as never), `job must reach terminal, got ${status}`);
  });

  test('错误文本无条件脱敏——物理根不泄漏', async () => {
    const id = 'pub_sessdel_redact_1';
    await workspaceManager.initWorkspace(id);
    const res = await app.request(`/sessions/${id}`, { method: 'DELETE', headers: {} });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error && !body.error.includes(base), `must be redacted: ${body.error}`);
  });
});
