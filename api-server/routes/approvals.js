/**
 * Route: POST /api/approvals/:id/decide — proxy sandbox approval decision
 * and notify Agent to resume any parked waiting_approval run (B6).
 */
import { createSandboxClient } from '../services/sandbox-client.js';
import { decideAgentApproval } from '../services/agent-client.js';
import { resolveTrustedAuth } from '../application/run-access-service.js';
import { decideApprovalAndResume } from '../application/approval-decision-service.js';
import { sendError, sendJson as json } from '../http/response.js';

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
    const client = createSandboxClient({ auth, traceId: req?.traceId });
    const outcome = await decideApprovalAndResume({
      sandbox: client,
      notifyAgent: (id, payload) =>
        decideAgentApproval(
          id,
          payload,
          { auth, traceId: req?.traceId },
        ),
      approvalId,
      decision,
      runId: body.run_id || null,
      reason: body.reason || null,
    });

    if (outcome.resumePending) {
      console.warn('[approvals] decision persisted; Agent resume is pending:', outcome.resumeError);
      json(res, 202, {
        ...outcome.result,
        agent_resume: null,
        agent_resume_status: 'pending',
        agent_resume_error: outcome.resumeError,
      });
      return;
    }

    json(res, 200, {
      ...outcome.result,
      agent_resume: outcome.agentResume,
      agent_resume_status: 'resumed',
    });
  } catch (err) {
    console.error('[approvals] decide:', err.message);
    sendError(res, err, req?.traceId);
  }
}
