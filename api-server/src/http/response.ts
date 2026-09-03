import type { ServerResponse } from 'node:http';
import { asHttpError } from './errors.js';

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function sendError(res: ServerResponse, error: unknown, traceId: string | null = null): void {
  const normalized = asHttpError(error);
  sendJson(res, normalized.status, {
    error: normalized.message,
    code: normalized.code,
    ...(traceId ? { trace_id: traceId } : {}),
  });
}

