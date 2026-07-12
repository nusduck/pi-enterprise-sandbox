/**
 * Route: POST /api/approvals/:id/decide — proxy sandbox approval decision
 * and notify Agent to resume any parked waiting_approval run (B6).
 */
import { authFromRequest, createSandboxClient } from '../services/sandbox-client.js';
import { decideAgentApproval } from '../services/agent-client.js';

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
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
    const client = createSandboxClient({ auth: authFromRequest(req) });
    const result = await client.decideApproval(approvalId, decision);

    // B6: wake agent waiter / resume parked run (best-effort; durable state is in sandbox)
    let agentResume = null;
    try {
      agentResume = await decideAgentApproval(approvalId, {
        decision,
        run_id: body.run_id || result?.payload?.run_id || null,
        reason: body.reason || result?.reason || null,
      });
    } catch (err) {
      console.warn('[approvals] agent resume notify failed:', err.message);
    }

    json(res, 200, { ...result, agent_resume: agentResume });
  } catch (err) {
    console.error('[approvals] decide:', err.message);
    json(res, err.status || 500, { error: err.message || 'Approval decision failed' });
  }
}
