/**
 * 公共面错误映射——逐字节对齐 Python sandbox 的 HTTP 语义。
 *
 * 为什么单独一层：`sandbox/routers/files.py` 的 `_search_http_error` 区分
 * PermissionError→403、ValueError→400，其它 400；`sanitize_path_error`
 * 无条件脱敏物理路径。这里把同一条纪律搬到 TS——任何离开公共面的错误
 * 文本都必须经 `redactPhysicalRoots`，且 status 必须与 Python 完全一致，
 * 否则 api-server 的 `SandboxError` 分支会误判（逐字节不变是本任务的验收线）。
 */

import { redactPhysicalRoots } from '../../fs/redact.js';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string | undefined,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function errorBody(
  err: unknown,
  physicalRoots: readonly string[],
  traceId?: string | undefined,
): Record<string, unknown> {
  const raw = err instanceof Error ? err.message : String(err);
  const redacted = redactPhysicalRoots(raw, physicalRoots);
  const code = err instanceof HttpError ? err.code : undefined;
  const body: Record<string, unknown> = { error: redacted };
  if (code !== undefined) body.code = code;
  if (traceId !== undefined) body.trace_id = traceId;
  // Python 的 attachment_upload 失败会带 detail.code，这里透出 code 供 BFF 的 mapUploadErrorBody 二次映射 400→413
  if (code !== undefined) body.detail = { code, message: redacted };
  return body;
}

export function notFound(message = 'Not found'): HttpError {
  return new HttpError(404, message, 'not_found');
}

export function forbidden(message = 'Forbidden'): HttpError {
  return new HttpError(403, message, 'forbidden');
}

export function badRequest(message: string, code?: string): HttpError {
  return new HttpError(400, message, code);
}

export function conflict(message: string): HttpError {
  return new HttpError(409, message);
}

export function payloadTooLarge(message: string, code: string): HttpError {
  return new HttpError(413, message, code);
}
