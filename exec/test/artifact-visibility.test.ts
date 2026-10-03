/**
 * 交付物可见性（design `agent-output-review.md` §3.3，ADR 0016 D1）。
 *
 * 这一组断言的是**执行点**，不是服务内部状态：每一条「review 会话拒绝」都配一条
 * 「direct 会话成功」作为正向对照（AGENTS.md §3：权限测试不能只有拒绝对照，
 * 否则"全部拒绝"也会假通过）。
 *
 * 覆盖 E1–E7 与 fail-closed：
 * - E1 会话产物列表只列 released；E2 下载非 released → 404；E3 产物库只列 released；
 *   E4 导入非 released → 404；E5 工作区读路径 → 404；E6 进程日志 → 404；
 *   E7 上传照常允许。
 * - 状态变更单向（held→released/withdrawn 之后不可再变）且幂等（outbox 至少一次）。
 * - 修订上传产生新产物（`revision_of` 链），原件不被覆盖，且修订版在放行前仍 404。
 * - 策略查询失败 → 503，不是放行。
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Hono } from 'hono';
import { Context as CordisContext } from '@deepseek-ai/cordis';
import { WorkspaceManager } from '../src/workspace/manager.js';
import { createPublicRouter } from '../src/http/public/router.js';
import { InMemoryJobStore } from '../src/shell/job-store-memory.js';
import { MySqlJobRegistry } from '../src/shell/job-registry.js';
import { ArtifactService } from '../src/artifact/service.js';
import { DatasetService } from '../src/dataset/service.js';
import { WorkspaceFileSystem } from '../src/fs/workspace-fs.js';
import {
  InMemoryWorkspacePolicyStore,
  type WorkspaceDelivery,
  type WorkspacePolicyStore,
} from '../src/db/repositories/workspace-policies.js';
import type { WorkspaceContext } from '../src/types.js';

describe('artifact visibility: review vs direct delivery', () => {
  let base: string;
  let workspaceManager: WorkspaceManager;
  let jobRegistry: MySqlJobRegistry;
  let artifactService: ArtifactService;
  let policies: InMemoryWorkspacePolicyStore;
  let app: Hono;
  const controlRoots = (): { artifactsRoot: string; controlRoot: string } => ({
    artifactsRoot: path.join(base, 'control', 'artifacts'),
    controlRoot: path.join(base, 'control', 'root'),
  });

  const acting = {
    'x-acting-organization-id': 'org_test',
    'x-acting-user-id': 'user_test',
  };
  const owner = { orgId: 'org_test', userId: 'user_test' };

  before(async () => {
    const resolved = await realpath(tmpdir());
    base = await mkdtemp(path.join(resolved, 'dsh-review-'));
    workspaceManager = new WorkspaceManager({
      workspacesBaseRoot: path.join(base, 'workspaces'),
      tempBaseRoot: path.join(base, 'tmp'),
    });
    jobRegistry = new MySqlJobRegistry(new InMemoryJobStore());
    const makeFs = (ws: WorkspaceContext) =>
      new WorkspaceFileSystem(new CordisContext() as never, ws);
    policies = new InMemoryWorkspacePolicyStore();
    artifactService = new ArtifactService(makeFs, undefined, {
      roots: controlRoots(),
      workspacePolicies: policies,
    });
    app = createPublicRouter({
      apiToken: null,
      workspaceManager,
      systemSkillRoot: path.join(base, 'skills'),
      enabledSkillPackagesFor: () => [],
      jobRegistry,
      artifactService,
      datasetService: new DatasetService(makeFs, undefined, { roots: controlRoots() }),
      workspacePolicies: policies,
    });
    await mkdir(path.join(base, 'skills'), { recursive: true });
  });

  after(async () => {
    await rm(base, { recursive: true, force: true });
  });

  /**
   * 建一个工作区、放一个源文件，按需要标成 review。
   * @returns {{id: string, source: string}}
   */
  async function session(id: string, delivery?: WorkspaceDelivery) {
    await workspaceManager.initWorkspace(id);
    const src = 'report.md';
    await writeFile(path.join(workspaceManager.physicalWorkspacePath(id), src), '# report\n');
    if (delivery === 'review') await policies.rememberReview(id, owner.orgId);
    return { id, source: src };
  }

  async function submitArtifact(
    id: string,
    source: string,
    name = 'report.md',
  ): Promise<{ artifact_id: string; status: number }> {
    const res = await app.request(`/sessions/${id}/artifacts/submit`, {
      method: 'POST',
      headers: { ...acting, 'content-type': 'application/json' },
      body: JSON.stringify({ path: source, name }),
    });
    const body = (await res.json().catch(() => ({}))) as { artifact_id?: string };
    return { artifact_id: body.artifact_id ?? '', status: res.status };
  }

  test('E2: review 工作区提交的产物是 held —— 下载 404；direct 同一步成功', async () => {
    const review = await session('vis_review_1', 'review');
    const direct = await session('vis_direct_1');

    const held = await submitArtifact(review.id, review.source);
    assert.equal(held.status, 201, '提交本身必须成功——产物是被扣住，不是被拒绝');
    const released = await submitArtifact(direct.id, direct.source);

    const denied = await app.request(
      `/sessions/${review.id}/artifacts/${held.artifact_id}/download`,
      { headers: acting },
    );
    assert.equal(denied.status, 404, '待审产物对发起人必须与不存在同一个 404');

    const allowed = await app.request(
      `/sessions/${direct.id}/artifacts/${released.artifact_id}/download`,
      { headers: acting },
    );
    assert.equal(allowed.status, 200, '正向对照：direct 会话必须能下载');
    assert.equal(await allowed.text(), '# report\n');
  });

  test('E1/E3: 会话产物列表与产物库都只列 released', async () => {
    const review = await session('vis_review_2', 'review');
    const direct = await session('vis_direct_2');
    await submitArtifact(review.id, review.source, 'held.md');
    await submitArtifact(direct.id, direct.source, 'visible.md');

    const listed = await app.request(`/sessions/${review.id}/artifacts`, { headers: acting });
    assert.equal(listed.status, 200);
    const sessionBody = (await listed.json()) as { artifacts: unknown[]; total: number };
    assert.deepEqual(sessionBody.artifacts, [], '会话列表里不允许出现 held 产物');

    const library = await app.request('/artifacts', { headers: acting });
    assert.equal(library.status, 200);
    const libraryBody = (await library.json()) as {
      artifacts: Array<{ name: string }>;
    };
    // 产物库是这个 owner 跨会话的视图：direct 的两件在，review 的都不在。
    assert.ok(libraryBody.artifacts.some((a) => a.name === 'visible.md'));
    assert.ok(!libraryBody.artifacts.some((a) => a.name === 'held.md'));
  });

  test('E4: 以 held 产物为源的导入 → 404；released 为源成功', async () => {
    const review = await session('vis_review_3', 'review');
    const direct = await session('vis_direct_3');
    const held = await submitArtifact(review.id, review.source);
    const released = await submitArtifact(direct.id, direct.source);

    const denied = await app.request(`/sessions/${review.id}/artifacts/imports`, {
      method: 'POST',
      headers: { ...acting, 'content-type': 'application/json' },
      body: JSON.stringify({ artifact_id: held.artifact_id }),
    });
    assert.equal(denied.status, 404);

    const allowed = await app.request(`/sessions/${direct.id}/artifacts/imports`, {
      method: 'POST',
      headers: { ...acting, 'content-type': 'application/json' },
      body: JSON.stringify({ artifact_id: released.artifact_id, target_filename: 'in.md' }),
    });
    assert.equal(allowed.status, 201);
  });

  test('E5/E6/E7: 工作区读路径 404，进程/数据集 404，上传照常', async () => {
    const review = await session('vis_review_4', 'review');
    const direct = await session('vis_direct_4');

    for (const [id, expected] of [
      [review.id, 404],
      [direct.id, 200],
    ] as const) {
      const files = await app.request(`/sessions/${id}/files?path=.`, { headers: acting });
      assert.equal(files.status, expected, `GET /files on ${id}`);
      const read = await app.request(`/sessions/${id}/files/read`, {
        method: 'POST',
        headers: { ...acting, 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'report.md' }),
      });
      assert.equal(read.status, expected, `POST /files/read on ${id}`);
      const download = await app.request(
        `/sessions/${id}/files/download?path=report.md`,
        { headers: acting },
      );
      assert.equal(download.status, expected, `GET /files/download on ${id}`);
      const grep = await app.request(`/sessions/${id}/files/grep`, {
        method: 'POST',
        headers: { ...acting, 'content-type': 'application/json' },
        body: JSON.stringify({ path: '.', query: 'report' }),
      });
      assert.equal(grep.status, expected, `POST /files/grep on ${id}`);
      const processes = await app.request(`/sessions/${id}/processes`, { headers: acting });
      assert.equal(processes.status, expected, `GET /processes on ${id}`);
      const datasets = await app.request(`/sessions/${id}/datasets`, { headers: acting });
      assert.equal(datasets.status, expected, `GET /datasets on ${id}`);
    }

    // E7：上传在两种工作区里都照常。
    const form = new FormData();
    form.append('file', new Blob(['材料'], { type: 'text/plain' }), 'material.txt');
    const upload = await app.request(`/sessions/${review.id}/files/upload?path=`, {
      method: 'POST',
      headers: acting,
      body: form,
    });
    assert.equal(upload.status, 201, 'review 会话必须还能上传材料');
  });

  test('状态变更：held → released 生效且再次变更无效（幂等 + 单向）', async () => {
    const review = await session('vis_review_5', 'review');
    const { artifact_id } = await submitArtifact(review.id, review.source);

    const release = await artifactService.applyVisibilities(owner.orgId, [
      { artifactId: artifact_id, visibility: 'released' },
    ]);
    assert.equal(release, 1);

    const now = await app.request(`/sessions/${review.id}/artifacts/${artifact_id}/download`, {
      headers: acting,
    });
    assert.equal(now.status, 200, '放行后必须可下载');

    // outbox 至少一次投递：重复放行不报错、也不再有变化。
    const again = await artifactService.applyVisibilities(owner.orgId, [
      { artifactId: artifact_id, visibility: 'released' },
    ]);
    assert.equal(again, 0);
    // 终态不可再变：放行之后不能又被撤回。
    const withdraw = await artifactService.applyVisibilities(owner.orgId, [
      { artifactId: artifact_id, visibility: 'withdrawn' },
    ]);
    assert.equal(withdraw, 0);
    const still = await app.request(`/sessions/${review.id}/artifacts/${artifact_id}/download`, {
      headers: acting,
    });
    assert.equal(still.status, 200, 'released 是终态');
  });

  test('撤回：held → withdrawn 后与不存在同一个 404', async () => {
    const review = await session('vis_review_6', 'review');
    const { artifact_id } = await submitArtifact(review.id, review.source);
    const changed = await artifactService.applyVisibilities(owner.orgId, [
      { artifactId: artifact_id, visibility: 'withdrawn' },
    ]);
    assert.equal(changed, 1);
    const res = await app.request(`/sessions/${review.id}/artifacts/${artifact_id}/download`, {
      headers: acting,
    });
    assert.equal(res.status, 404);
  });

  test('跨租户：别的 org 改不动本 org 的产物', async () => {
    const review = await session('vis_review_7', 'review');
    const { artifact_id } = await submitArtifact(review.id, review.source);
    const changed = await artifactService.applyVisibilities('org_other', [
      { artifactId: artifact_id, visibility: 'released' },
    ]);
    assert.equal(changed, 0, 'org 作用域不匹配时一行都不该动');
    assert.equal(await artifactService.getInOrg(artifact_id, 'org_other'), null);
  });

  test('修订上传：新产物 + revision_of 链，原件保留，修订版放行前仍 404', async () => {
    const review = await session('vis_review_8', 'review');
    const original = await submitArtifact(review.id, review.source);

    const revision = await artifactService.submitRevision({
      originalArtifactId: original.artifact_id,
      orgId: owner.orgId,
      bytes: Buffer.from('# report v2\n', 'utf8'),
      mimeType: 'text/markdown',
    });
    assert.notEqual(revision.artifactId, original.artifact_id, '原件不能被覆盖');
    assert.equal(revision.revisionOf, original.artifact_id);
    assert.equal(revision.createdByKind, 'reviewer');
    assert.equal(revision.visibility, 'held');
    // 修订版在放行前对发起人也不可见。
    const denied = await app.request(
      `/sessions/${review.id}/artifacts/${revision.artifactId}/download`,
      { headers: acting },
    );
    assert.equal(denied.status, 404);
    // 原件仍然存在（只是 held），链没有断。
    const stillThere = await artifactService.getInOrg(original.artifact_id, owner.orgId);
    assert.equal(stillThere?.visibility, 'held');
  });

  test('fail-closed：策略查询失败 → 读 503，不是放行', async () => {
    const id = 'vis_failing_1';
    await workspaceManager.initWorkspace(id);
    const broken: WorkspacePolicyStore = {
      rememberReview: async () => {},
      reviewOwnerOf: async () => {
        throw new Error('policy store is down');
      },
      deliveryOf: async () => {
        throw new Error('policy store is down');
      },
    };
    const makeFs = (ws: WorkspaceContext) =>
      new WorkspaceFileSystem(new CordisContext() as never, ws);
    const failingApp = createPublicRouter({
      apiToken: null,
      workspaceManager,
      systemSkillRoot: path.join(base, 'skills'),
      enabledSkillPackagesFor: () => [],
      jobRegistry,
      artifactService: new ArtifactService(makeFs, undefined, {
        roots: controlRoots(),
        workspacePolicies: broken,
      }),
      workspacePolicies: broken,
    });

    const res = await failingApp.request(`/sessions/${id}/files?path=.`, { headers: acting });
    assert.equal(res.status, 503, '策略读不到时必须 503，不能当作 direct 放行');
    const body = (await res.json()) as { error: string; code?: string };
    assert.equal(body.code, 'workspace_policy_unavailable');
    assert.ok(!body.error.includes(base), `必须脱敏：${body.error}`);
  });
});
