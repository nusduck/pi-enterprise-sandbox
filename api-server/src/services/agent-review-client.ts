/**
 * 审核员面的 Agent 端调用（`/internal/reviews*`，design `agent-output-review.md` §7）。
 *
 * 与 `agent-member-role-client.ts` 同一纪律：**BFF 只转发与投影身份**。`reviewer`
 * 角色判定、org 作用域、跨租户 404、职责分离与并发冲突全在 agent/，这里不做二次
 * 判断，也不缓存（BFF 手上只有请求头里的角色，没有账本）。
 *
 * 单独成文件：`agent-client.ts` 贴着行数棘轮，且字节流（下载/修订上传）与 JSON
 * 请求的超时口径不同（15s 的默认 deadline 不够一次 512MiB 的修订上传）。
 */
import { agentFetch, requestHeaders } from './agent-client.js';
import { config } from '../config.js';

type Opts = { auth?: any; traceId?: string | null; signal?: AbortSignal | null };

/** 字节流（下载与修订上传）的 deadline：与文件上传同量级。 */
export const REVIEW_BYTE_TIMEOUT_MS = 10 * 60 * 1000;

/** Agent 接受的查询键；浏览器多带的键一律丢掉。 */
const LIST_KEYS = ['status', 'mine', 'cursor', 'limit'] as const;

function agentUrl(path: string, query?: URLSearchParams | null): URL {
  const url = new URL(`${config.AGENT_BASE_URL}/internal/reviews${path}`);
  if (query) for (const [k, v] of query) url.searchParams.set(k, v);
  return url;
}

async function throwAgentError(resp: Response, fallback: string): Promise<never> {
  const payload: any = await resp.json().catch(() => ({}));
  const error: any = new Error(
    typeof payload.error === 'string' ? payload.error : `${fallback} (${resp.status})`,
  );
  error.status = resp.status;
  if (typeof payload.code === 'string') error.code = payload.code;
  throw error;
}

async function requestJson(
  path: string,
  query: URLSearchParams | null,
  opts: Opts,
  method = 'GET',
  body?: unknown,
): Promise<any> {
  const resp = await agentFetch(agentUrl(path, query), {
    method,
    headers: requestHeaders({
      auth: opts.auth,
      traceId: opts.traceId,
      ...(body === undefined ? {} : { extra: { 'Content-Type': 'application/json' } }),
    }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!resp.ok) await throwAgentError(resp, 'Agent review request failed');
  return resp.json();
}

function pick(source: URLSearchParams, keys: readonly string[]): URLSearchParams {
  const out = new URLSearchParams();
  for (const key of keys) {
    const value = source.get(key);
    if (value != null && value !== '') out.set(key, value);
  }
  return out;
}

export function listReviews(source: URLSearchParams, opts: Opts = {}): Promise<any> {
  return requestJson('', pick(source, LIST_KEYS), opts);
}

export function getReview(reviewTaskId: string, opts: Opts = {}): Promise<any> {
  return requestJson(`/${encodeURIComponent(reviewTaskId)}`, null, opts);
}

export function claimReview(reviewTaskId: string, opts: Opts = {}): Promise<any> {
  return requestJson(`/${encodeURIComponent(reviewTaskId)}/claim`, null, opts, 'POST', {});
}

export function releaseReview(reviewTaskId: string, opts: Opts = {}): Promise<any> {
  return requestJson(`/${encodeURIComponent(reviewTaskId)}/release`, null, opts, 'POST', {});
}

export function approveReview(
  reviewTaskId: string,
  body: { base_revision: number; note?: string | null },
  opts: Opts = {},
): Promise<any> {
  return requestJson(`/${encodeURIComponent(reviewTaskId)}/approve`, null, opts, 'POST', body);
}

export function rejectReview(
  reviewTaskId: string,
  body: { base_revision: number; feedback: string },
  opts: Opts = {},
): Promise<any> {
  return requestJson(`/${encodeURIComponent(reviewTaskId)}/reject`, null, opts, 'POST', body);
}

/**
 * 字节流请求：**不用** `agentFetch`（它的 deadline 是 15s，读一次 512MiB 的产物
 * 会被中途掐断）。这里自己设一个与文件上传同量级的 deadline，只覆盖到响应头——
 * 响应体的读取由调用方按背压推进。
 */
async function fetchBytes(url: URL, init: RequestInit, signal?: AbortSignal | null): Promise<Response> {
  const timeout = AbortSignal.timeout(REVIEW_BYTE_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  return await fetch(url, { ...init, signal: combined });
}

/** 材料快照下载：把 agent 的响应交给调用方流式转发。 */
export async function openReviewMaterial(
  reviewTaskId: string,
  materialId: string,
  opts: Opts = {},
): Promise<Response> {
  const url = agentUrl(
    `/${encodeURIComponent(reviewTaskId)}/materials/${encodeURIComponent(materialId)}/download`,
  );
  const resp = await fetchBytes(url, {
    headers: requestHeaders({ auth: opts.auth, traceId: opts.traceId }),
  }, opts.signal);
  if (!resp.ok) await throwAgentError(resp, 'Agent review material download failed');
  return resp;
}

/** 交付物任一版本下载（限本任务内的 artifact）。 */
export async function openReviewArtifact(
  reviewTaskId: string,
  artifactId: string,
  opts: Opts = {},
): Promise<Response> {
  const url = agentUrl(
    `/${encodeURIComponent(reviewTaskId)}/artifacts/${encodeURIComponent(artifactId)}/download`,
  );
  const resp = await fetchBytes(url, {
    headers: requestHeaders({ auth: opts.auth, traceId: opts.traceId }),
  }, opts.signal);
  if (!resp.ok) await throwAgentError(resp, 'Agent review artifact download failed');
  return resp;
}

/**
 * 上传修订文件：**原始字节 body**，不是 multipart。
 *
 * 与附件上传同一条纪律（`routes/files.ts` 的注释）：multipart 包装会让存下来的
 * MIME 变成 `multipart/form-data`，把类型判断和预览一起弄坏。
 */
export async function uploadReviewRevision(
  reviewTaskId: string,
  itemNo: number,
  input: {
    baseRevision: number;
    filename: string;
    mimeType: string;
    /** 流式 body（`Readable`）；类型由 fetch 的 `duplex: 'half'` 路径接受。 */
    body: any;
    duplex?: 'half';
    signal?: AbortSignal | null;
  },
  opts: Opts = {},
): Promise<Response> {
  const url = agentUrl(
    `/${encodeURIComponent(reviewTaskId)}/items/${encodeURIComponent(String(itemNo))}/revisions`,
    new URLSearchParams({ base_revision: String(input.baseRevision) }),
  );
  const resp = await fetchBytes(url, {
    method: 'POST',
    headers: requestHeaders({
      auth: opts.auth,
      traceId: opts.traceId,
      extra: {
        'Content-Type': input.mimeType || 'application/octet-stream',
        'X-Filename': encodeURIComponent(input.filename),
      },
    }),
    body: input.body,
    ...(input.duplex ? { duplex: input.duplex } : {}),
  } as RequestInit, input.signal);
  if (!resp.ok) await throwAgentError(resp, 'Agent review revision upload failed');
  return resp;
}
