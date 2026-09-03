export class HttpError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

export function asHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  const status = Number((error as { status?: unknown })?.status) || 500;
  const code = (error as { code?: string })?.code || (status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED');
  const message = status >= 500 ? 'Internal server error' : (error as { message?: string })?.message || 'Request failed';
  return new HttpError(status, code, message, { cause: error });
}

