/**
 * Route: POST /api/approvals/:id/decide — proxy sandbox approval decision
 */
import { authFromRequest, createSandboxClient } from '../services/sandbox-client.js';

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/**
 * POST /api/approvals/:id/decide  body: { decision: 'approve' | 'reject' }
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
    json(res, 200, result);
  } catch (err) {
    console.error('[approvals] decide:', err.message);
    json(res, err.status || 500, { error: err.message || 'Approval decision failed' });
  }
}
