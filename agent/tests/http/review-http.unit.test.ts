/**
 * 审核员路由（`/internal/reviews*`，design `agent-output-review.md` §7）。
 *
 * 走**真实的 HTTP 服务器**：这里证明的是路由层的形状——路径解析、方法分发、身份头
 * 缺失时的 400、原始字节 body 的转发、二进制下载的头，以及服务端错误码
 * （403 / 404 / 409 / 422）原样透传。
 * 「谁能审、能不能审」的语义在应用服务里证明，不在这里用替身假装。
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createAgentHttpServer } from '../../src/bootstrap/create-http-server.js';
import { ReviewError } from '../../src/application/review-service.js';

const TASK = '01K0G2PAV8FPMVC9QHJG7JPN70';
const MATERIAL = '01K0G2PAV8FPMVC9QHJG7JPN71';
const ARTIFACT = 'art_0123456789abcdef';

/** 记录调用的替身服务：只回答「路由把什么转给了服务」。 */
function stubService() {
  const calls: any[] = [];
  return {
    calls,
    async listTasks(actor: any, query: any) {
      calls.push({ op: 'list', actor, query });
      return { tasks: [{ review_task_id: TASK, status: 'PENDING', revision: 0 }], next_cursor: null };
    },
    async getTaskDetail(actor: any, reviewTaskId: string) {
      calls.push({ op: 'detail', actor, reviewTaskId });
      if (reviewTaskId === 'missing') throw new ReviewError(404, 'NOT_FOUND', 'Review task not found');
      return { review_task_id: reviewTaskId, status: 'IN_REVIEW', revision: 3, items: [], materials: [], events: [] };
    },
    async claim(actor: any, reviewTaskId: string) {
      calls.push({ op: 'claim', actor, reviewTaskId });
      throw new ReviewError(403, 'REVIEW_SELF_FORBIDDEN', 'You cannot review your own run');
    },
    async releaseClaim(actor: any, reviewTaskId: string) {
      calls.push({ op: 'release', actor, reviewTaskId });
      return { review_task_id: reviewTaskId, status: 'PENDING' };
    },
    async uploadRevision(actor: any, reviewTaskId: string, itemNo: number, input: any) {
      calls.push({ op: 'revision', actor, reviewTaskId, itemNo, input });
      return { review_task_id: reviewTaskId, revision: input.baseRevision + 1 };
    },
    async approve(actor: any, reviewTaskId: string, input: any) {
      calls.push({ op: 'approve', actor, reviewTaskId, input });
      if (input.baseRevision !== 3) {
        throw new ReviewError(409, 'REVIEW_VERSION_CONFLICT', 'This task was updated by someone else', {
          current_revision: 4,
        });
      }
      return { review_task_id: reviewTaskId, status: 'APPROVED' };
    },
    async reject(actor: any, reviewTaskId: string, input: any) {
      calls.push({ op: 'reject', actor, reviewTaskId, input });
      if (!String(input.feedback ?? '').trim()) {
        throw new ReviewError(422, 'REVIEW_FEEDBACK_REQUIRED', 'Rejection feedback is required');
      }
      return { review_task_id: reviewTaskId, status: 'REJECTED' };
    },
    async readMaterial(actor: any, reviewTaskId: string, materialId: string) {
      calls.push({ op: 'material', actor, reviewTaskId, materialId });
      if (materialId !== MATERIAL) throw new ReviewError(404, 'NOT_FOUND', 'Review task not found');
      return {
        filename: '材料.pdf',
        mimeType: 'text/html',
        bytes: Buffer.from('snapshot-bytes'),
        sha256: 'a'.repeat(64),
      };
    },
    async readArtifact(actor: any, reviewTaskId: string, artifactId: string) {
      calls.push({ op: 'artifact', actor, reviewTaskId, artifactId });
      if (artifactId !== ARTIFACT) throw new ReviewError(404, 'NOT_FOUND', 'Review task not found');
      return {
        filename: '报告.md',
        mimeType: 'text/markdown',
        bytes: Buffer.from('# report\n'),
        sha256: 'b'.repeat(64),
      };
    },
  };
}

describe('审核员路由 (/internal/reviews*)', () => {
  let server: any;
  let port: number;
  let service: ReturnType<typeof stubService>;

  before(async () => {
    service = stubService();
    server = createAgentHttpServer({
      createRunService: { execute: async () => ({}) },
      getRunService: { execute: async () => ({}) },
      cancelRunService: { execute: async () => ({}) },
      eventQueryService: { listEvents: async () => ({ events: [] }) },
      reviewService: service,
      config: { ALLOW_UNAUTHENTICATED_INTERNAL: true },
    } as any);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  after(async () => new Promise<void>((resolve) => server.close(() => resolve())));

  const acting = (role = 'reviewer') => ({
    'x-acting-user-id': '01K0G2PAV8FPMVC9QHJG7JPN60',
    'x-acting-organization-id': '01K0G2PAV8FPMVC9QHJG7JPN61',
    'x-acting-role': role,
  });
  const url = (path: string) => `http://127.0.0.1:${port}${path}`;

  it('缺 X-Acting-* 身份头时 400，且不碰服务', async () => {
    const response = await fetch(url('/internal/reviews'));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'AUTH_CONTEXT_REQUIRED');
    assert.equal(service.calls.length, 0);
  });

  it('GET 列表把查询参数投影给服务', async () => {
    const response = await fetch(url('/internal/reviews?status=PENDING&mine=true&limit=5'), {
      headers: acting(),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.tasks.length, 1);
    const call = service.calls.at(-1);
    assert.deepEqual(call.query, { status: 'PENDING', mine: true, cursor: null, limit: '5' });
    assert.equal(call.actor.role, 'reviewer');
  });

  it('详情：404 由服务决定，路由原样透传', async () => {
    assert.equal((await fetch(url(`/internal/reviews/${TASK}`), { headers: acting() })).status, 200);
    const missing = await fetch(url('/internal/reviews/missing'), { headers: acting() });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).code, 'NOT_FOUND');
  });

  it('领取：职责分离的 403 原样透传（不是被路由吞成 500）', async () => {
    const response = await fetch(url(`/internal/reviews/${TASK}/claim`), {
      method: 'POST',
      headers: acting(),
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'REVIEW_SELF_FORBIDDEN');
  });

  it('释放领取走 POST，方法不对时 405', async () => {
    const ok = await fetch(url(`/internal/reviews/${TASK}/release`), { method: 'POST', headers: acting() });
    assert.equal(ok.status, 200);
    const wrong = await fetch(url(`/internal/reviews/${TASK}/release`), { headers: acting() });
    assert.equal(wrong.status, 405);
  });

  it('通过：JSON body 的 base_revision 透传，版本冲突带 current_revision', async () => {
    const ok = await fetch(url(`/internal/reviews/${TASK}/approve`), {
      method: 'POST',
      headers: { ...acting(), 'content-type': 'application/json' },
      body: JSON.stringify({ base_revision: 3, note: '没问题' }),
    });
    assert.equal(ok.status, 200);
    assert.equal(service.calls.at(-1).input.note, '没问题');

    const conflict = await fetch(url(`/internal/reviews/${TASK}/approve`), {
      method: 'POST',
      headers: { ...acting(), 'content-type': 'application/json' },
      body: JSON.stringify({ base_revision: 1 }),
    });
    assert.equal(conflict.status, 409);
    const body = await conflict.json();
    assert.equal(body.code, 'REVIEW_VERSION_CONFLICT');
    assert.equal(body.current_revision, 4);
  });

  it('驳回：反馈缺失由服务给 422 REVIEW_FEEDBACK_REQUIRED', async () => {
    const response = await fetch(url(`/internal/reviews/${TASK}/reject`), {
      method: 'POST',
      headers: { ...acting(), 'content-type': 'application/json' },
      body: JSON.stringify({ base_revision: 3, feedback: '   ' }),
    });
    assert.equal(response.status, 422);
    assert.equal((await response.json()).code, 'REVIEW_FEEDBACK_REQUIRED');
  });

  it('修订上传：原始字节 body 原样到达服务，base_revision 与文件名从查询/头解析', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    const response = await fetch(
      url(`/internal/reviews/${TASK}/items/2/revisions?base_revision=7`),
      {
        method: 'POST',
        headers: {
          ...acting(),
          'content-type': 'image/png',
          'x-filename': encodeURIComponent('改过的图.png'),
        },
        body: bytes,
      },
    );
    assert.equal(response.status, 200);
    const call = service.calls.at(-1);
    assert.equal(call.itemNo, 2);
    assert.equal(call.input.baseRevision, '7');
    assert.equal(call.input.filename, '改过的图.png');
    assert.equal(call.input.mimeType, 'image/png');
    // 二进制一个字节都不能被改写（utf8 解码会把它变成 U+FFFD）。
    assert.deepEqual(Buffer.from(call.input.bytes), bytes);
  });

  it('修订上传：item 段不是正整数或动作不对时 404', async () => {
    assert.equal(
      (await fetch(url(`/internal/reviews/${TASK}/items/0/revisions`), { method: 'POST', headers: acting() })).status,
      404,
    );
    assert.equal(
      (await fetch(url(`/internal/reviews/${TASK}/items/2/other`), { method: 'POST', headers: acting() })).status,
      404,
    );
  });

  it('材料快照下载：二进制 + nosniff + html 降级 + 文件名头', async () => {
    const response = await fetch(url(`/internal/reviews/${TASK}/materials/${MATERIAL}/download`), {
      headers: acting(),
    });
    assert.equal(response.status, 200);
    // 审核员下载的也是用户生成内容：html 一律降级，避免在浏览器里当页面执行。
    assert.equal(response.headers.get('content-type'), 'application/octet-stream');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-artifact-filename'), encodeURIComponent('材料.pdf'));
    assert.equal(Buffer.from(await response.arrayBuffer()).toString('utf8'), 'snapshot-bytes');
  });

  it('交付物下载：限本任务内的 artifact（不属于任务时 404）', async () => {
    const ok = await fetch(url(`/internal/reviews/${TASK}/artifacts/${ARTIFACT}/download`), { headers: acting() });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'text/markdown');
    assert.equal(Buffer.from(await ok.arrayBuffer()).toString('utf8'), '# report\n');

    const other = await fetch(url(`/internal/reviews/${TASK}/artifacts/art_other/download`), { headers: acting() });
    assert.equal(other.status, 404);
  });

  it('未知段与非 GET/POST 的组合给 404/405，不落到别的路由', async () => {
    assert.equal((await fetch(url(`/internal/reviews/${TASK}/nope`), { headers: acting() })).status, 404);
    assert.equal(
      (await fetch(url(`/internal/reviews/${TASK}/claim`), { headers: acting() })).status,
      405,
    );
    assert.equal(
      (await fetch(url(`/internal/reviews/${TASK}/materials/${MATERIAL}/download`), { method: 'POST', headers: acting() })).status,
      405,
    );
  });

  it('未装配审核服务时 503，而不是静默 404', async () => {
    const bare = createAgentHttpServer({
      createRunService: { execute: async () => ({}) },
      getRunService: { execute: async () => ({}) },
      cancelRunService: { execute: async () => ({}) },
      eventQueryService: { listEvents: async () => ({ events: [] }) },
      config: { ALLOW_UNAUTHENTICATED_INTERNAL: true },
    } as any);
    await new Promise<void>((resolve) => bare.listen(0, '127.0.0.1', resolve));
    const barePort = (bare.address() as any).port;
    try {
      const response = await fetch(`http://127.0.0.1:${barePort}/internal/reviews`, { headers: acting() });
      assert.equal(response.status, 503);
      assert.equal((await response.json()).code, 'DEPENDENCY');
    } finally {
      await new Promise<void>((resolve) => bare.close(() => resolve()));
    }
  });
});
