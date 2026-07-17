/**
 * HTTP header names for external and internal request context (plan §6.1).
 *
 * Browser-supplied org_id / user_id must not be trusted; BFF resolves them
 * from authenticated identity and membership.
 */

/** External (client → BFF) headers. */
export const EXTERNAL_CONTEXT_HEADERS = {
  authorization: 'Authorization',
  requestId: 'X-Request-Id',
  idempotencyKey: 'X-Idempotency-Key',
  traceparent: 'traceparent',
  tracestate: 'tracestate',
} as const;

/** Internal (BFF → Agent → Sandbox) headers. */
export const INTERNAL_CONTEXT_HEADERS = {
  orgId: 'X-Org-Id',
  userId: 'X-User-Id',
  conversationId: 'X-Conversation-Id',
  agentSessionId: 'X-Agent-Session-Id',
  runId: 'X-Run-Id',
  sandboxSessionId: 'X-Sandbox-Session-Id',
  requestId: 'X-Request-Id',
  traceparent: 'traceparent',
  tracestate: 'tracestate',
} as const;

export type ExternalContextHeader =
  (typeof EXTERNAL_CONTEXT_HEADERS)[keyof typeof EXTERNAL_CONTEXT_HEADERS];

export type InternalContextHeader =
  (typeof INTERNAL_CONTEXT_HEADERS)[keyof typeof INTERNAL_CONTEXT_HEADERS];

/** Case-insensitive header lookup for Node IncomingHttpHeaders-like maps. */
export function getHeader(
  headers: Record<string, unknown> | null | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) continue;
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  }
  return undefined;
}
