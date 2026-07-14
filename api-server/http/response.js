import { asHttpError } from './errors.js';

export function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function sendError(res, error, traceId = null) {
  const normalized = asHttpError(error);
  sendJson(res, normalized.status, {
    error: normalized.message,
    code: normalized.code,
    ...(traceId ? { trace_id: traceId } : {}),
  });
}
