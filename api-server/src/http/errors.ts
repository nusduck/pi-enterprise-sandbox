export class HttpError extends Error {
  status: number;
  code: string;
  /**
   * 上游给出的结构化补充字段（例如激活冲突时的当前 active_version_id）。
   * 只放已白名单的键——BFF 不能把 agent/ 的任意错误载荷原样转给浏览器。
   */
  details: Record<string, unknown> | null;

  constructor(
    status: number,
    code: string,
    message: string,
    options: ErrorOptions & { details?: Record<string, unknown> | null } = {},
  ) {
    super(message, options);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = options.details ?? null;
  }
}

export function asHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  const status = Number((error as { status?: unknown })?.status) || 500;
  const code = (error as { code?: string })?.code || (status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED');
  const message = status >= 500 ? 'Internal server error' : (error as { message?: string })?.message || 'Request failed';
  const details = (error as { details?: unknown })?.details;
  return new HttpError(status, code, message, {
    cause: error,
    ...(details && typeof details === 'object' && !Array.isArray(details)
      ? { details: details as Record<string, unknown> }
      : {}),
  });
}

