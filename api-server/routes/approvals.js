/**
 * Approval API. Agent MySQL is the only read/write authority.
 */
import {
  decideAgentApproval,
  getAgentApproval,
  listAgentApprovals,
} from '../services/agent-client.js';
import { resolveTrustedAuth } from '../application/run-access-service.js';
import { sendError, sendJson as json } from '../http/response.js';

/** GET /api/approvals — Agent MySQL is the approval read authority. */
export async function handleListApprovals(parsedUrl, res, req = null) {
  try {
    const auth = await resolveTrustedAuth(req);
    const result = await listAgentApprovals(
      {
        status: parsedUrl.searchParams.get('status') || null,
        limit: parsedUrl.searchParams.get('limit') || null,
      },
      { auth, traceId: req?.traceId },
    );
    json(res, 200, result);
  } catch (err) {
    console.error('[approvals] list:', err.message);
    sendError(res, err, req?.traceId);
  }
}

/** GET /api/approvals/:id — owner-scoped Agent MySQL detail. */
export async function handleGetApproval(approvalId, res, req = null) {
  try {
    const auth = await resolveTrustedAuth(req);
    const result = await getAgentApproval(approvalId, {
      auth,
      traceId: req?.traceId,
    });
    json(res, 200, result);
  } catch (err) {
    console.error('[approvals] get:', err.message);
    sendError(res, err, req?.traceId);
  }
}

/**
 * POST /api/approvals/:id/decide  body: { decision: 'approve' | 'reject', run_id? }
 */
export async function handleDecideApproval(approvalId, body, res, req = null) {
  const decision = body?.decision;
  if (!approvalId) {
    json(res, 400, { error: 'approval id is required' });
    return;
  }
  if (decision !== 'approve' && decision !== 'reject') {
    json(res, 400, { error: "decision must be 'approve' or 'reject'" });
    return;
  }
  try {
    const auth = await resolveTrustedAuth(req);
    const outcome = await decideAgentApproval(
      approvalId,
      {
        decision,
        run_id: body.run_id || null,
        reason: body.reason || null,
      },
      { auth, traceId: req?.traceId },
    );
    const resumePending = Boolean(
      outcome.resumePending ?? outcome.resume_pending,
    );

    if (resumePending) {
      console.warn(
        '[approvals] decision persisted; Agent resume is pending:',
        outcome.resumeError || outcome.resume_error,
      );
      json(res, 202, {
        ...outcome,
        agent_resume: null,
        agent_resume_status: 'pending',
        agent_resume_error: outcome.resumeError || outcome.resume_error || null,
      });
      return;
    }

    json(res, 200, {
      ...outcome,
      agent_resume: { queued: outcome.queued === true },
      agent_resume_status: outcome.queued ? 'queued' : 'not_required',
    });
  } catch (err) {
    console.error('[approvals] decide:', err.message);
    sendError(res, err, req?.traceId);
  }
}
