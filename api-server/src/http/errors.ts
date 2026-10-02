export class HttpError extends Error {
  status: number;
  code: string;
  /**
   * agent 给的具体诊断码（如 `DELEGATION_AGENT_UNKNOWN`），与稳定的通用
   * `code`（如 `VALIDATION_ERROR`）并存（docs/api.md「保存失败的诊断码出口」）。
   * 只在存在时序列化；没有就是没有，不编造。
   */
  reasonCode: string | null;
  /**
   * 上游给出的结构化补充字段（例如激活冲突时的当前 active_version_id，
   * 或 agent 错误体自带的 `details` 对象）。
   * 只放已白名单的键——BFF 不能把 agent/ 的任意错误载荷原样转给浏览器。
   */
  details: Record<string, unknown> | null;

  constructor(
    status: number,
    code: string,
    message: string,
    options: ErrorOptions & { details?: Record<string, unknown> | null; reasonCode?: string | null } = {},
  ) {
    super(message, options);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.reasonCode = typeof options.reasonCode === 'string' && options.reasonCode !== ''
      ? options.reasonCode
      : null;
    this.details = options.details ?? null;
  }
}

export function asHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  const status = Number((error as { status?: unknown })?.status) || 500;
  const code = (error as { code?: string })?.code || (status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED');
  const message = status >= 500 ? 'Internal server error' : (error as { message?: string })?.message || 'Request failed';
  const details = (error as { details?: unknown })?.details;
  const record = error as { reason_code?: unknown; reasonCode?: unknown };
  const reasonCode =
    typeof record?.reason_code === 'string' && record.reason_code !== ''
      ? record.reason_code
      : typeof record?.reasonCode === 'string' && record.reasonCode !== ''
        ? record.reasonCode
        : null;
  return new HttpError(status, code, message, {
    cause: error,
    ...(reasonCode ? { reasonCode } : {}),
    ...(details && typeof details === 'object' && !Array.isArray(details)
      ? { details: details as Record<string, unknown> }
      : {}),
  });
}

