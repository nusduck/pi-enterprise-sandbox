/**
 * Conversation CRUD and run/event timeline are both Agent MySQL authority.
 */
import type { ServerResponse } from 'node:http';
import {
  createAgentConversation,
  deleteAgentConversation,
  getAgentConversation,
  listAgentConversations,
  listAgentRuns,
  listAgentEvents,
} from '../services/agent-client.js';
import { resolveTrustedAuth, type ReqWithTrace } from '../application/run-access-service.js';
import { loadConversationTimeline } from '../application/conversation-timeline-service.js';
import { HttpError } from '../http/errors.js';
import { sendError, sendJson as json } from '../http/response.js';

/** Crockford ULID — the only conversation id shape Agent MySQL issues. */
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

function isUlid(value: unknown): boolean {
  return typeof value === 'string' && ULID_RE.test(value);
}

/**
 * GET /api/conversations
 */
export async function handleListConversations(res: ServerResponse, req: ReqWithTrace | null = null): Promise<void> {
  try {
    const auth = await resolveTrustedAuth(req);
    const list = await listAgentConversations({ auth, traceId: req?.traceId });
    json(res, 200, list);
  } catch (err: any) {
    console.error('[conversations] list:', err.message);
    sendError(res, err, req?.traceId);
  }
}

/**
 * GET /api/conversations/:id
 */
export async function handleGetConversation(id: string, res: ServerResponse, req: ReqWithTrace | null = null): Promise<void> {
  try {
    const auth = await resolveTrustedAuth(req);
    const conv = await getAgentConversation(id, {
      auth,
      traceId: req?.traceId,
    });
    json(res, 200, conv);
  } catch (err: any) {
    console.error('[conversations] get:', err.message);
    sendError(res, err, req?.traceId);
  }
}

/**
 * POST /api/conversations  body: { title?, agent_id? }
 *
 * `agent_id` 只透传，不校验：Agent 是否属于本 org、是否活跃、活跃版本是哪一个，
 * 全部由 agent/ 在事务内判定（AGENTS.md §1「不要在 BFF 里补状态」）。
 * 与 `runs.ts` follow-up 的既有写法保持一致。
 */
export async function handleCreateConversation(body: any, res: ServerResponse, req: ReqWithTrace | null = null): Promise<void> {
  try {
    const title = body?.title || 'New chat';
    const auth = await resolveTrustedAuth(req);
    const conv = await createAgentConversation(
      { title, agent_id: body?.agent_id || null },
      { auth, traceId: req?.traceId },
    );
    json(res, 201, conv);
  } catch (err: any) {
    console.error('[conversations] create:', err.message);
    sendError(res, err, req?.traceId);
  }
}

/**
 * DELETE /api/conversations/:id
 */
export async function handleDeleteConversation(id: string, res: ServerResponse, req: ReqWithTrace | null = null): Promise<void> {
  try {
    const auth = await resolveTrustedAuth(req);
    await deleteAgentConversation(id, { auth, traceId: req?.traceId });
    res.writeHead(204);
    res.end();
  } catch (err: any) {
    console.error('[conversations] delete:', err.message);
    sendError(res, err, req?.traceId);
  }
}

/** GET /api/conversations/:id/events — complete persisted run timeline (Agent MySQL). */
export async function handleGetConversationEvents(
  id: string,
  res: ServerResponse,
  req: ReqWithTrace | null = null,
  query: Record<string, any> = {},
): Promise<void> {
  try {
    // Resolve the browser session into trusted Agent owner headers before
    // loading the Agent MySQL run/event timeline.
    const auth = await resolveTrustedAuth(req);
    const traceId = req?.traceId || null;
    // Fail closed on the conversation itself first. The run listing below is
    // a filter, not an existence check: a conversation that belongs to another
    // tenant, was deleted, or never existed matches no runs and would answer
    // 200 with an empty timeline — indistinguishable from an owned but idle
    // conversation. A malformed id must not reach Agent as a 500 either.
    if (!isUlid(id)) {
      throw new HttpError(404, 'NOT_FOUND', 'Conversation not found');
    }
    await getAgentConversation(id, { auth, traceId });
    const client = {
      listAgentRuns: (q: any) => listAgentRuns(q, { auth, traceId }),
      listAgentEvents: (runId: string, q?: any) => listAgentEvents(runId, q, { auth, traceId }),
    };
    const limit = query['limit'] != null ? Number(query['limit']) : undefined;
    const timeline = await loadConversationTimeline(client, id, {
      limit: Number.isFinite(limit) ? limit : undefined,
    });
    json(res, 200, timeline);
  } catch (err: any) {
    console.error('[conversations] events:', err.message);
    sendError(res, err, req?.traceId);
  }
}

