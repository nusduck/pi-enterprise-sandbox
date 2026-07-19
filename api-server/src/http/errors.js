export class HttpError extends Error {
  constructor(status, code, message, options = {}) {
    super(message, options);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

export function asHttpError(error) {
  if (error instanceof HttpError) return error;
  const status = Number(error?.status) || 500;
  return new HttpError(
    status,
    error?.code || (status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED'),
    status >= 500 ? 'Internal server error' : error?.message || 'Request failed',
    { cause: error },
  );
}
