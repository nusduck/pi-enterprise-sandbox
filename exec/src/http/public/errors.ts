/**
 * 公共面错误映射——逐字节对齐已退役的 Python 执行面的 HTTP 语义。
 *
 * 为什么单独一层：旧 `sandbox/routers/files.py` 的 `_search_http_error` 区分
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

/**
 * 业务错误 → HTTP 错误的通用映射（F19 合并 `mapError` / `datasetHttpError`）。
 *
 * 三段逻辑两处完全一致：`HttpError` 原样透出；业务错误类（`ArtifactError` /
 * `DatasetError`，都有 `{ status, code, message }`）脱敏后按自带 status 映射；
 * 其余兜底 500 并脱敏。调用方显式传业务错误类，行为与合并前一致。
 */
export function domainHttpError(
  err: unknown,
  roots: readonly string[],
  DomainError: new (...args: never[]) => Error & { status: number; code: string },
): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof DomainError) {
    return new HttpError(err.status, redactPhysicalRoots(err.message, roots), err.code);
  }
  const raw = err instanceof Error ? err.message : String(err);
  return new HttpError(500, redactPhysicalRoots(raw, roots));
}
