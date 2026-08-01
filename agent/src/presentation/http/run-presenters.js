export function presentCreateRunResponse(result) {
  const sandboxSessionId =
    result.sandboxSessionId ?? result.sandbox_session_id ?? result.session_id ?? null;
  // One spelling per field: snake_case, matching the rest of the public wire.
  return {
    run_id: result.runId,
    status: result.status,
    conversation_id: result.conversationId,
    events_url: result.eventsUrl,
    agent_session_id: result.agentSessionId ?? null,
    session_id: sandboxSessionId,
    sandbox_session_id: sandboxSessionId,
    queue_warning: result.queueWarning ?? null,
    replayed: result.replayed === true,
  };
}

export function presentGetRunResponse(run) {
  const pending = run.pendingInput || run.pending_input || null;
  const pendingInput = pending
    ? {
        interaction_id: pending.interactionId || pending.interaction_id || null,
        interaction_type:
          pending.interactionType || pending.interaction_type || 'input',
        title: pending.title ?? 'Input required',
        message: pending.message ?? null,
        options: Array.isArray(pending.options) ? pending.options : [],
        status: pending.status || 'PENDING',
      }
    : null;
  const completedAt = run.completedAt ?? run.completed_at ?? null;
  const nextEventSequence = Number(
    run.nextEventSequence ?? run.next_event_sequence,
  );
  const lastSequence =
    Number.isFinite(nextEventSequence) && nextEventSequence > 0
      ? nextEventSequence - 1
      : null;
  const modelId = run.modelId ?? run.model_id ?? null;
  const usage = run.usage ?? run.tokenUsage ?? run.token_usage ?? null;
  const sandboxSessionId =
    run.sandboxSessionId ?? run.sandbox_session_id ?? run.session_id ?? null;
  // One spelling per field: snake_case. `completed_at` and `finished_at` are
  // deliberately both kept — two documented names for the same instant.
  return {
    run_id: run.runId,
    status: run.status,
    conversation_id: run.conversationId,
    agent_session_id: run.agentSessionId,
    session_id: sandboxSessionId,
    sandbox_session_id: sandboxSessionId,
    org_id: run.orgId,
    user_id: run.userId,
    trace_id: run.traceId,
    attempt: run.attempt,
    status_reason: run.statusReason,
    cancel_requested_at: run.cancelRequestedAt,
    created_at: run.createdAt,
    updated_at: run.updatedAt,
    started_at: run.startedAt,
    completed_at: completedAt,
    finished_at: completedAt,
    last_sequence: lastSequence,
    last_event_id: run.lastEventId ?? run.last_event_id ?? null,
    model_id: modelId,
    // `usage` and `token_usage` are two documented names for one value, like
    // completed_at/finished_at — kept as-is; only camelCase twins were dropped.
    usage,
    token_usage: usage,
    pending_input: pendingInput,
  };
}

const PUBLIC_TOOL_STATUS = Object.freeze({
  PROPOSED: 'prepared',
  WAITING_APPROVAL: 'waiting_approval',
  RUNNING: 'executing',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  UNKNOWN: 'unknown',
});

export function presentToolExecutionResponse(tool) {
  const status = PUBLIC_TOOL_STATUS[String(tool.status)] || 'unknown';
  return {
    tool_execution_id: tool.toolExecutionId,
    tool_call_id: tool.toolCallId,
    run_id: tool.runId,
    agent_session_id: tool.agentSessionId,
    tool_name: tool.toolName,
    tool_source: tool.toolSource,
    risk_level: tool.riskLevel,
    arguments: tool.argumentsJson ?? {},
    result_json: tool.resultJson ?? null,
    status,
    error_code: tool.errorCode ?? null,
    error: tool.errorCode ?? null,
    started_at: tool.startedAt ?? null,
    completed_at: tool.completedAt ?? null,
    finished_at: tool.completedAt ?? null,
    created_at: tool.createdAt ?? null,
    updated_at: tool.completedAt ?? tool.startedAt ?? tool.createdAt ?? null,
  };
}

export function presentProcessResponse(process) {
  return {
    process_id: process.processId,
    session_id: process.sandboxSessionId,
    sandbox_session_id: process.sandboxSessionId,
    run_id: process.runId,
    execution_id: process.executionId,
    command: process.command || '',
    status: process.status,
    pid: process.pid ?? null,
    exit_code: process.exitCode ?? null,
    started_at: process.startedAt ?? null,
    finished_at: process.endedAt ?? null,
    created_at: process.createdAt ?? null,
  };
}
