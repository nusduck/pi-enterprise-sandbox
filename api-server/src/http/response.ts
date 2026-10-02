import type { ServerResponse } from 'node:http';
import { asHttpError } from './errors.js';

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * 带 trace 的 JSON 写回（C5 A5 收敛点）。
 *
 * `X-Trace-Id` 响应头 + body 里补 `trace_id`（body 自带的优先，不覆盖）。
 * 此前 `datasets.ts writeJson` / `files.ts writeUploadJson` /
 * `sessions.ts json` 各写一份，语义相同。
 */
export function sendJsonWithTrace(
  res: ServerResponse,
  status: number,
  body: unknown,
  traceId?: string | null,
): void {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (traceId) headers['X-Trace-Id'] = traceId;
  const payload =
    traceId && body && typeof body === 'object' && (body as any).trace_id == null
      ? { ...(body as any), trace_id: traceId }
      : body;
  res.writeHead(status, headers);
  res.end(JSON.stringify(payload));
}

export function sendError(res: ServerResponse, error: unknown, traceId: string | null = null): void {
  const normalized = asHttpError(error);
  sendJson(res, normalized.status, {
    error: normalized.message,
    code: normalized.code,
    ...(normalized.reasonCode != null ? { reason_code: normalized.reasonCode } : {}),
    ...(normalized.details ?? {}),
    ...(traceId ? { trace_id: traceId } : {}),
  });
}

