/**
 * 审核员端客户端（`/api/reviews*`，design `docs/design/agent-output-review.md` §7）。
 *
 * `reviewer` 判定、org 作用域、跨租户 404、职责分离与全部 `REVIEW_*` 码都在服务端
 * （agent/），这里只做请求投影、zod 校验与**错误码保真**：页面要靠 `code` 把 409
 * 翻译成一句能行动的中文提示（「任务已被更新」），退化成「操作失败」等于让审核员猜。
 *
 * 用 `parseApiStrict`：列表契约漂移必须抛错并显示错误态，不能软失败成一个空队列
 * ——「加载失败渲染成没有待审任务」正是设计 §8 明确禁止的。
 */
import { z } from 'zod';
import { parseApiStrict } from '../schemas/api';
import { ApiError, authHeaders } from './client';

const nullableString = z.string().nullable().optional();

const ReviewUserSchema = z
  .object({ user_id: z.string(), display_name: nullableString })
  .passthrough();

export const ReviewTaskSchema = z
  .object({
    review_task_id: z.string(),
    status: z.string(),
    run_status: z.string().optional(),
    revision: z.number(),
    requester: ReviewUserSchema.optional(),
    assignee: ReviewUserSchema.nullable().optional(),
    item_count: z.number().optional(),
    created_at: nullableString,
    claimed_at: nullableString,
    decided_at: nullableString,
    feedback: nullableString,
  })
  .passthrough();
export type ReviewTask = z.infer<typeof ReviewTaskSchema>;

const ReviewTaskPageSchema = z.object({
  tasks: z.array(ReviewTaskSchema).default([]),
  next_cursor: z.string().nullable().optional(),
});

const ReviewAttachmentSchema = z
  .object({
    attachment_id: z.string(),
    filename: z.string(),
    mime_type: nullableString,
    size: z.number().optional(),
  })
  .passthrough();

const ReviewQuestionSchema = z
  .object({
    message_id: z.string(),
    sequence_no: z.number(),
    text: z.string().default(''),
    created_at: nullableString,
    attachments: z.array(ReviewAttachmentSchema).default([]),
  })
  .passthrough();

const ReviewMaterialSchema = z
  .object({
    material_id: z.string(),
    attachment_id: z.string(),
    filename: z.string(),
    mime_type: nullableString,
    size: z.number().optional(),
    /** `ready` | `unavailable`：快照失败是看得见的状态，不是静默缺失。 */
    snapshot_status: z.string(),
  })
  .passthrough();
export type ReviewMaterial = z.infer<typeof ReviewMaterialSchema>;

const ReviewVersionSchema = z
  .object({ artifact_id: z.string(), current: z.boolean(), revision: z.number() })
  .passthrough();

const ReviewItemSchema = z
  .object({
    item_no: z.number(),
    name: z.string(),
    mime_type: nullableString,
    size: z.number().optional(),
    sha256: nullableString,
    original_artifact_id: z.string(),
    current_artifact_id: z.string(),
    revised: z.boolean().default(false),
    versions: z.array(ReviewVersionSchema).default([]),
  })
  .passthrough();
export type ReviewItem = z.infer<typeof ReviewItemSchema>;

const ReviewEventSchema = z
  .object({
    event_id: z.string(),
    event_type: z.string(),
    actor_user_id: nullableString,
    item_no: z.number().nullable().optional(),
    from_artifact_id: nullableString,
    to_artifact_id: nullableString,
    detail: nullableString,
    created_at: nullableString,
  })
  .passthrough();
export type ReviewEvent = z.infer<typeof ReviewEventSchema>;

export const ReviewDetailSchema = z
  .object({
    review_task_id: z.string(),
    status: z.string(),
    revision: z.number(),
    run_status: z.string().optional(),
    run_id: z.string().optional(),
    conversation_id: z.string().optional(),
    requester: ReviewUserSchema.optional(),
    assignee: ReviewUserSchema.nullable().optional(),
    agent: z.object({ agent_id: z.string().optional(), version_no: z.number().nullable().optional() }).passthrough().optional(),
    created_at: nullableString,
    claimed_at: nullableString,
    decided_at: nullableString,
    decided_by: ReviewUserSchema.nullable().optional(),
    feedback: nullableString,
    questions: z.array(ReviewQuestionSchema).default([]),
    materials: z.array(ReviewMaterialSchema).default([]),
    items: z.array(ReviewItemSchema).default([]),
    events: z.array(ReviewEventSchema).default([]),
  })
  .passthrough();
export type ReviewDetail = z.infer<typeof ReviewDetailSchema>;

export interface ReviewListFilters {
  status?: string | null;
  mine?: boolean;
  cursor?: string | null;
  limit?: number;
}

async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  const resp = await fetch(`/api/reviews${path}`, {
    ...init,
    headers: { ...authHeaders(), ...(init.headers || {}) },
  });
  const text = await resp.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!resp.ok) {
    const body = (payload || {}) as { error?: unknown; code?: unknown; current_revision?: unknown };
    throw new ApiError(String(body.error || `请求失败（HTTP ${resp.status}）`), {
      status: resp.status,
      code: typeof body.code === 'string' ? body.code : null,
      detail: body,
    });
  }
  return payload;
}

export async function listReviews(f: ReviewListFilters = {}): Promise<{ tasks: ReviewTask[]; next_cursor: string | null }> {
  const q = new URLSearchParams();
  if (f.status) q.set('status', f.status);
  if (f.mine) q.set('mine', 'true');
  if (f.cursor) q.set('cursor', f.cursor);
  q.set('limit', String(f.limit ?? 20));
  const page = parseApiStrict(ReviewTaskPageSchema, await request(`?${q}`), 'reviews');
  return { tasks: page.tasks, next_cursor: page.next_cursor ?? null };
}

export async function getReview(reviewTaskId: string): Promise<ReviewDetail> {
  return parseApiStrict(
    ReviewDetailSchema,
    await request(`/${encodeURIComponent(reviewTaskId)}`),
    'review detail',
  );
}

export async function claimReview(reviewTaskId: string): Promise<ReviewDetail> {
  return parseApiStrict(
    ReviewDetailSchema,
    await request(`/${encodeURIComponent(reviewTaskId)}/claim`, { method: 'POST' }),
    'review claim',
  );
}

export async function releaseReview(reviewTaskId: string): Promise<ReviewDetail> {
  return parseApiStrict(
    ReviewDetailSchema,
    await request(`/${encodeURIComponent(reviewTaskId)}/release`, { method: 'POST' }),
    'review release',
  );
}

export async function approveReview(
  reviewTaskId: string,
  input: { baseRevision: number; note?: string | null },
): Promise<ReviewDetail> {
  return parseApiStrict(
    ReviewDetailSchema,
    await request(`/${encodeURIComponent(reviewTaskId)}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_revision: input.baseRevision, note: input.note ?? null }),
    }),
    'review approve',
  );
}

export async function rejectReview(
  reviewTaskId: string,
  input: { baseRevision: number; feedback: string },
): Promise<ReviewDetail> {
  return parseApiStrict(
    ReviewDetailSchema,
    await request(`/${encodeURIComponent(reviewTaskId)}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_revision: input.baseRevision, feedback: input.feedback }),
    }),
    'review reject',
  );
}

/**
 * 上传修订文件：**原始字节 body**，不是 multipart。
 *
 * 与附件/数据集上传同一条纪律（`shared/api/datasets.ts` 的注释）：multipart 包装会让
 * 存下来的 MIME 变成 `multipart/form-data`，把类型判断与预览一起弄坏。
 */
export async function uploadReviewRevision(
  reviewTaskId: string,
  itemNo: number,
  input: { baseRevision: number; file: File | Blob; filename?: string; signal?: AbortSignal | null },
): Promise<ReviewDetail> {
  const filename = input.filename || (input.file as File).name || 'revision';
  const headers = authHeaders();
  headers['Content-Type'] = input.file.type || 'application/octet-stream';
  headers['X-Filename'] = encodeURIComponent(filename);
  const q = new URLSearchParams({ base_revision: String(input.baseRevision) });
  return parseApiStrict(
    ReviewDetailSchema,
    await request(
      `/${encodeURIComponent(reviewTaskId)}/items/${encodeURIComponent(String(itemNo))}/revisions?${q}`,
      {
        method: 'POST',
        headers,
        body: input.file,
        ...(input.signal ? { signal: input.signal } : {}),
      },
    ),
    'review revision',
  );
}

/** 材料快照下载 URL（同源、cookie 认证；与产物下载同一手法）。 */
export function reviewMaterialUrl(reviewTaskId: string, materialId: string): string {
  return `/api/reviews/${encodeURIComponent(reviewTaskId)}/materials/${encodeURIComponent(materialId)}/download`;
}

/** 交付物任一版本的下载 URL（限本任务内的 artifact）。 */
export function reviewArtifactUrl(reviewTaskId: string, artifactId: string): string {
  return `/api/reviews/${encodeURIComponent(reviewTaskId)}/artifacts/${encodeURIComponent(artifactId)}/download`;
}
