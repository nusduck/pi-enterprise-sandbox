/**
 * 游标分页列表契约（design/ui-polish.md §2.4）。
 *
 * 服务端把四个列表接口的响应统一成 `{ <items>: [...], next_cursor: string | null }`，
 * `next_cursor === null` 表示「到底」。前端这一层只做两件事，两件都容易错：
 *
 * 1. **请求参数**：`limit`/`cursor`/`q` 只在调用方给了的时候才进 query——不替服务端
 *    决定默认值，也不能让 `q` 里的 `&`/`=` 把查询串撑破；
 * 2. **响应形状**：`next_cursor` 必须是 `string | null`，不能是 `undefined`。
 *    `undefined !== null`，把「没有下一页」读成「还有下一页」会让调用方原地转圈。
 *
 * 同时钉住兼容性：`listApprovals` / `listCronJobs` / `listSkillShareQueue` 这三个
 * 数组版函数仍有未迁移的调用方（`entityBridge.ts`、`pages/...`），必须继续返回数组，
 * 且请求形状不变（不多带 limit）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { listConversations } from '../src/shared/api/client.ts';
import { listApprovals, listApprovalsPage } from '../src/shared/api/approvals.ts';
import { listCronJobs, listCronJobsPage } from '../src/shared/api/cron-jobs.ts';
import {
  listSkillShareQueue,
  listSkillShareQueuePage,
} from '../src/shared/api/skillSharing.ts';
import { ApprovalListSchema } from '../src/shared/schemas/management.ts';

describe('listConversations：新对象形状与查询参数', () => {
  it('limit/cursor/q 进 query，返回 conversations 与 next_cursor', async (t) => {
    const seen: Array<{ url: URL; init: RequestInit }> = [];
    t.after(stubFetch(async (input, init) => {
      seen.push({ url: new URL(String(input), ORIGIN), init: init ?? {} });
      return jsonResponse(200, {
        conversations: [{ id: 'c1', title: 'Hello' }],
        next_cursor: 'cur_2',
      });
    }));

    const result = await listConversations({ limit: 100, cursor: 'cur_1', q: 'a&b=c d' });

    assert.equal(seen[0].url.pathname, '/api/conversations');
    // 空格按 application/x-www-form-urlencoded 序列化成 `+`；`&`/`=` 必须转义，
    // 否则 `q` 会被服务端切成两个参数。
    assert.equal(seen[0].url.search, '?limit=100&cursor=cur_1&q=a%26b%3Dc+d');
    assert.deepEqual(
      [...seen[0].url.searchParams],
      [['limit', '100'], ['cursor', 'cur_1'], ['q', 'a&b=c d']],
    );
    assert.deepEqual(result.conversations.map((c) => c.id), ['c1']);
    assert.equal(result.next_cursor, 'cur_2');
  });

  it('没给的参数不进 query（null 等于没给，默认值由服务端定）', async (t) => {
    const seen: URL[] = [];
    t.after(stubFetch(async (input) => {
      seen.push(new URL(String(input), ORIGIN));
      return jsonResponse(200, { conversations: [], next_cursor: null });
    }));

    await listConversations();
    await listConversations({ limit: 100, cursor: null, q: null });

    assert.equal(seen[0].search, '');
    assert.equal(seen[1].search, '?limit=100');
  });

  it('next_cursor=null 就是到底，原样透出 null', async (t) => {
    t.after(stubFetch(async () => jsonResponse(200, {
      conversations: [{ id: 'c1' }],
      next_cursor: null,
    })));

    const result = await listConversations({ limit: 100 });
    assert.equal(result.next_cursor, null);
  });

  it('响应缺 next_cursor 时按「到底」处理，而不是 undefined', async (t) => {
    t.after(stubFetch(async () => jsonResponse(200, {
      conversations: [{ id: 'c1' }],
    })));

    const result = await listConversations({ limit: 100 });
    assert.equal(result.next_cursor, null);
  });

  it('旧版裸数组响应不会把 undefined 当列表交给调用方', async (t) => {
    t.after(stubFetch(async () => jsonResponse(200, [{ id: 'c1' }])));

    const result = await listConversations({ limit: 100 });
    assert.deepEqual(result.conversations, []);
    assert.equal(result.next_cursor, null);
  });
});

describe('ApprovalListSchema：容忍两种形状并接受 next_cursor', () => {
  it('对象形状带 next_cursor（字符串与 null）都能解析', () => {
    const withCursor = ApprovalListSchema.parse({
      approvals: [{ id: 'a1' }],
      next_cursor: 'cur_2',
    });
    assert.ok(!Array.isArray(withCursor));
    assert.equal(withCursor.next_cursor, 'cur_2');

    const lastPage = ApprovalListSchema.parse({ approvals: [], next_cursor: null });
    assert.ok(!Array.isArray(lastPage));
    assert.equal(lastPage.next_cursor, null);
  });

  it('裸数组形状继续可用（旧 BFF / 历史夹具）', () => {
    const parsed = ApprovalListSchema.parse([{ id: 'a1' }, { id: 'a2' }]);
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed.length, 2);
  });
});

describe('listApprovalsPage：转发筛选与游标，保留软失败', () => {
  it('status/limit/cursor 都在 query 上，返回 approvals 与 next_cursor', async (t) => {
    const seen: URL[] = [];
    t.after(stubFetch(async (input) => {
      seen.push(new URL(String(input), ORIGIN));
      return jsonResponse(200, { approvals: [{ id: 'a1' }], next_cursor: 'cur_2' });
    }));

    const page = await listApprovalsPage({ status: 'pending', limit: 50, cursor: 'cur_1' });

    assert.equal(seen[0].pathname, '/api/approvals');
    assert.deepEqual(
      [...seen[0].searchParams],
      [['status', 'pending'], ['limit', '50'], ['cursor', 'cur_1']],
    );
    assert.deepEqual(page.approvals.map((a) => a.id), ['a1']);
    assert.equal(page.next_cursor, 'cur_2');
  });

  it('接口缺失（404/501/405）与其它失败都返回空页，不抛', async (t) => {
    const statuses = [404, 501, 405, 500];
    let index = 0;
    t.after(stubFetch(async () => jsonResponse(statuses[index++], { error: 'nope' })));
    for (const _status of statuses) {
      assert.deepEqual(await listApprovalsPage({ status: 'pending' }), {
        approvals: [],
        next_cursor: null,
      });
    }
  });

  it('fetch 直接抛错也返回空页（entityBridge 依赖这条不炸）', async (t) => {
    t.after(stubFetch(async () => { throw new TypeError('network down'); }));
    assert.deepEqual(await listApprovalsPage(), { approvals: [], next_cursor: null });
    assert.deepEqual(await listApprovals({ status: 'pending' }), []);
  });
});

describe('数组版兼容层（未迁移的调用方）', () => {
  it('listApprovals 仍返回数组，且不替调用方加 limit', async (t) => {
    const seen: URL[] = [];
    t.after(stubFetch(async (input) => {
      seen.push(new URL(String(input), ORIGIN));
      return jsonResponse(200, { approvals: [{ id: 'a1' }], next_cursor: 'cur_2' });
    }));

    const list = await listApprovals({ status: 'pending' });

    assert.ok(Array.isArray(list));
    assert.deepEqual(list.map((a) => a.id), ['a1']);
    assert.deepEqual([...seen[0].searchParams], [['status', 'pending']]);
  });

  it('listCronJobs / listCronJobsPage', async (t) => {
    const seen: URL[] = [];
    const body = { cron_jobs: [{ cron_job_id: 'job_1' }], next_cursor: 'cur_2' };
    t.after(stubFetch(async (input) => {
      seen.push(new URL(String(input), ORIGIN));
      return jsonResponse(200, body);
    }));

    const page = await listCronJobsPage({ limit: 50, cursor: 'cur_1' });
    assert.equal(seen[0].pathname, '/api/cron-jobs');
    assert.deepEqual([...seen[0].searchParams], [['limit', '50'], ['cursor', 'cur_1']]);
    assert.deepEqual(page.cron_jobs.map((j) => j.cron_job_id), ['job_1']);
    assert.equal(page.next_cursor, 'cur_2');

    const list = await listCronJobs();
    assert.ok(Array.isArray(list));
    assert.deepEqual(list.map((j) => j.cron_job_id), ['job_1']);
    assert.equal(seen[1].search, '');
  });

  it('listSkillShareQueue / listSkillShareQueuePage', async (t) => {
    const seen: URL[] = [];
    const body = { requests: [{ requestId: 'r1' }], next_cursor: 'cur_2' };
    t.after(stubFetch(async (input) => {
      seen.push(new URL(String(input), ORIGIN));
      return jsonResponse(200, body);
    }));

    const page = await listSkillShareQueuePage({
      status: 'pending',
      limit: 50,
      cursor: 'cur_1',
    });
    assert.equal(seen[0].pathname, '/api/admin/skills/share-requests');
    assert.deepEqual(
      [...seen[0].searchParams],
      [['status', 'pending'], ['limit', '50'], ['cursor', 'cur_1']],
    );
    assert.deepEqual(page.requests.map((r) => r.requestId), ['r1']);
    assert.equal(page.next_cursor, 'cur_2');

    const list = await listSkillShareQueue('pending');
    assert.ok(Array.isArray(list));
    assert.deepEqual(list.map((r) => r.requestId), ['r1']);
    assert.deepEqual([...seen[1].searchParams], [['status', 'pending']]);

    // 没有 status 时 query 为空串（不是 `?limit=50`）。
    await listSkillShareQueue();
    assert.equal(seen[2].search, '');
  });

  it('listSkillShareQueue 仍是硬失败：把 code 带出来', async (t) => {
    t.after(stubFetch(async () => jsonResponse(403, {
      error: 'Administrator role is required',
      code: 'ADMIN_REQUIRED',
    })));

    await assert.rejects(listSkillShareQueuePage({ status: 'pending' }), (err) => {
      assert.equal(err.status, 403);
      assert.equal(err.code, 'ADMIN_REQUIRED');
      return true;
    });
    await assert.rejects(listSkillShareQueue('pending'), (err) => err.status === 403);
  });
});

/** BFF 的路由是相对路径；测试里给它们一个固定 origin 才解析得动。 */
const ORIGIN = 'http://bff.test';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type FetchHandler = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function stubFetch(handler: FetchHandler): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = handler as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
  };
}
