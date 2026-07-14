/** Persist an approval decision, then reliably notify the Agent runtime. */
export async function decideApprovalAndResume({
  sandbox,
  notifyAgent,
  approvalId,
  decision,
  runId = null,
  reason = null,
  attempts = 3,
}) {
  const result = await sandbox.decideApproval(approvalId, decision);
  const payload = {
    decision,
    run_id: runId || result?.payload?.run_id || null,
    reason: reason || result?.reason || null,
  };

  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const agentResume = await notifyAgent(approvalId, payload);
      return { result, agentResume, resumePending: false, attempts: attempt };
    } catch (error) {
      lastError = error;
      const retryable = !error?.status || Number(error.status) >= 500;
      if (!retryable || attempt === attempts) break;
    }
  }

  return {
    result,
    agentResume: null,
    resumePending: true,
    attempts,
    resumeError: lastError?.message || 'Agent resume notification failed',
  };
}
