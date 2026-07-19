/**
 * Map MySQL snake_case rows ↔ domain camelCase shapes (plan §8).
 */

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
export function parseJsonColumn(value) {
  if (value == null) return {};
  if (typeof value === 'object' && !Buffer.isBuffer(value)) {
    return /** @type {Record<string, unknown>} */ (value);
  }
  if (typeof value === 'string') {
    return JSON.parse(value);
  }
  throw new Error(`Unsupported JSON column value type: ${typeof value}`);
}

/**
 * Parse a datetime at the MySQL boundary. DATETIME has no timezone, so a
 * string without an explicit offset is a UTC wall-clock value rather than a
 * host-local timestamp.
 *
 * @param {unknown} value
 * @returns {Date}
 */
function parseDateTimeAsUtc(value) {
  if (value instanceof Date) return value;
  if (typeof value !== 'string') {
    throw new Error(`Unsupported datetime value: ${typeof value}`);
  }
  const raw = value.trim().includes('T')
    ? value.trim()
    : value.trim().replace(' ', 'T');
  const withZone =
    raw.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(raw)
      ? raw
      : `${raw}Z`;
  const parsed = new Date(withZone);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid datetime value: ${value}`);
  }
  return parsed;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
export function formatDateTime(value) {
  if (value == null) return null;
  return parseDateTimeAsUtc(value).toISOString();
}

/**
 * @param {Record<string, unknown>} row
 */
export function mapOrganization(row) {
  return {
    orgId: String(row.org_id),
    name: String(row.name),
    status: String(row.status),
    createdAt: formatDateTime(row.created_at),
    updatedAt: formatDateTime(row.updated_at),
  };
}

/**
 * @param {Record<string, unknown>} row
 */
export function mapUser(row) {
  return {
    userId: String(row.user_id),
    externalSubject: String(row.external_subject),
    displayName: row.display_name == null ? null : String(row.display_name),
    email: row.email == null ? null : String(row.email),
    status: String(row.status),
    createdAt: formatDateTime(row.created_at),
    updatedAt: formatDateTime(row.updated_at),
  };
}

/**
 * @param {Record<string, unknown>} row
 */
export function mapConversation(row) {
  return {
    conversationId: String(row.conversation_id),
    orgId: String(row.org_id),
    userId: String(row.user_id),
    agentId: String(row.agent_id),
    title: row.title == null ? null : String(row.title),
    status: String(row.status),
    currentAgentSessionId:
      row.current_agent_session_id == null
        ? null
        : String(row.current_agent_session_id),
    createdAt: formatDateTime(row.created_at),
    updatedAt: formatDateTime(row.updated_at),
    archivedAt: formatDateTime(row.archived_at),
  };
}

/**
 * @param {Record<string, unknown>} row
 */
export function mapMessage(row) {
  return {
    messageId: String(row.message_id),
    conversationId: String(row.conversation_id),
    agentSessionId:
      row.agent_session_id == null ? null : String(row.agent_session_id),
    runId: row.run_id == null ? null : String(row.run_id),
    role: String(row.role),
    messageType: String(row.message_type),
    contentJson: parseJsonColumn(row.content_json),
    sequenceNo: Number(row.sequence_no),
    // PR-05 slice B journal markers (nullable; absent on pre-journal rows).
    piEntryId: row.pi_entry_id == null ? null : String(row.pi_entry_id),
    piEntryKind: row.pi_entry_kind == null ? null : String(row.pi_entry_kind),
    createdAt: formatDateTime(row.created_at),
  };
}

/**
 * @param {Record<string, unknown>} row
 */
export function mapAgentSession(row) {
  return {
    agentSessionId: String(row.agent_session_id),
    orgId: String(row.org_id),
    userId: String(row.user_id),
    conversationId: String(row.conversation_id),
    agentVersionId: String(row.agent_version_id),
    sandboxSessionId: String(row.sandbox_session_id),
    workspaceId: String(row.workspace_id),
    status: String(row.status),
    piSessionVersion: Number(row.pi_session_version ?? 0),
    lastRunId: row.last_run_id == null ? null : String(row.last_run_id),
    // PR-05 fencing / recovery (migration 20260718000005); default when absent.
    executionFenceToken: Number(row.execution_fence_token ?? 0),
    recoveryReasonCode:
      row.recovery_reason_code == null
        ? null
        : String(row.recovery_reason_code),
    createdAt: formatDateTime(row.created_at),
    updatedAt: formatDateTime(row.updated_at),
    closedAt: formatDateTime(row.closed_at),
  };
}

/**
 * Map agent_session_snapshots row (plan §8.9). Snapshot is an acceleration
 * artifact, not the sole truth.
 * @param {Record<string, unknown>} row
 */
export function mapAgentSessionSnapshot(row) {
  return {
    snapshotId: String(row.snapshot_id),
    agentSessionId: String(row.agent_session_id),
    snapshotVersion: Number(row.snapshot_version),
    snapshotFormat: String(row.snapshot_format),
    snapshotJson:
      row.snapshot_json == null ? null : parseJsonColumn(row.snapshot_json),
    workspacePath:
      row.workspace_path == null ? null : String(row.workspace_path),
    checksum: String(row.checksum),
    piSdkVersion: String(row.pi_sdk_version),
    capturedFenceToken: Number(row.captured_fence_token ?? 0),
    createdAt: formatDateTime(row.created_at),
  };
}

/**
 * @param {Record<string, unknown>} row
 */
export function mapRun(row) {
  return {
    runId: String(row.run_id),
    orgId: String(row.org_id),
    userId: String(row.user_id),
    conversationId: String(row.conversation_id),
    agentSessionId: String(row.agent_session_id),
    agentVersionId: String(row.agent_version_id),
    triggeringMessageId: String(row.triggering_message_id),
    source: String(row.source),
    status: String(row.status),
    statusReason: row.status_reason == null ? null : String(row.status_reason),
    queueName: String(row.queue_name),
    attempt: Number(row.attempt),
    traceId: String(row.trace_id),
    traceState: row.trace_state == null ? null : String(row.trace_state),
    nextEventSequence: Number(row.next_event_sequence),
    startedAt: formatDateTime(row.started_at),
    completedAt: formatDateTime(row.completed_at),
    createdAt: formatDateTime(row.created_at),
    updatedAt: formatDateTime(row.updated_at),
  };
}

/**
 * @param {Record<string, unknown>} row
 */
export function mapRunEvent(row) {
  return {
    eventId: String(row.event_id),
    runId: String(row.run_id),
    orgId: String(row.org_id),
    sequenceNo: Number(row.sequence_no),
    eventType: String(row.event_type),
    eventVersion: Number(row.event_version),
    payloadJson: parseJsonColumn(row.payload_json),
    traceId: String(row.trace_id),
    spanId: row.span_id == null ? null : String(row.span_id),
    createdAt: formatDateTime(row.created_at),
  };
}

/**
 * @param {Record<string, unknown>} row
 */
export function mapToolExecution(row) {
  return {
    toolExecutionId: String(row.tool_execution_id),
    runId: String(row.run_id),
    agentSessionId: String(row.agent_session_id),
    toolCallId: String(row.tool_call_id),
    toolName: String(row.tool_name),
    toolSource: String(row.tool_source),
    riskLevel: String(row.risk_level),
    argumentsJson: parseJsonColumn(row.arguments_json),
    resultJson:
      row.result_json == null ? null : parseJsonColumn(row.result_json),
    status: String(row.status),
    errorCode: row.error_code == null ? null : String(row.error_code),
    traceId: String(row.trace_id),
    // PR-07B batch 2A claim fields — nullable; never coerce null → 0.
    requestHash: row.request_hash == null ? null : String(row.request_hash),
    requestHashVersion:
      row.request_hash_version == null
        ? null
        : Number(row.request_hash_version),
    executionFenceToken:
      row.execution_fence_token == null
        ? null
        : Number(row.execution_fence_token),
    startedAt: formatDateTime(row.started_at),
    completedAt: formatDateTime(row.completed_at),
    createdAt: formatDateTime(row.created_at),
  };
}

/**
 * @param {Record<string, unknown>} row
 */
export function mapApproval(row) {
  return {
    approvalId: String(row.approval_id),
    orgId: String(row.org_id),
    runId: String(row.run_id),
    conversationId:
      row.conversation_id == null ? null : String(row.conversation_id),
    toolExecutionId: String(row.tool_execution_id),
    requestedBy: String(row.requested_by),
    decisionBy: row.decision_by == null ? null : String(row.decision_by),
    status: String(row.status),
    requestJson: parseJsonColumn(row.request_json),
    decisionReason:
      row.decision_reason == null ? null : String(row.decision_reason),
    expiresAt: formatDateTime(row.expires_at),
    createdAt: formatDateTime(row.created_at),
    decidedAt: formatDateTime(row.decided_at),
  };
}

/** Map a durable user interaction row. */
export function mapInteraction(row) {
  return {
    interactionId: String(row.interaction_id),
    orgId: String(row.org_id),
    userId: String(row.user_id),
    runId: String(row.run_id),
    agentSessionId: String(row.agent_session_id),
    toolExecutionId: String(row.tool_execution_id),
    toolCallId: String(row.tool_call_id),
    interactionType: String(row.interaction_type),
    requestJson: parseJsonColumn(row.request_json),
    status: String(row.status),
    responseJson:
      row.response_json == null ? null : parseJsonColumn(row.response_json),
    responseHash: row.response_hash == null ? null : String(row.response_hash),
    respondedBy: row.responded_by == null ? null : String(row.responded_by),
    resumePhase:
      row.resume_phase == null ? 'NONE' : String(row.resume_phase),
    createdAt: formatDateTime(row.created_at),
    resolvedAt: formatDateTime(row.resolved_at),
    resumeClaimedAt: formatDateTime(row.resume_claimed_at),
    resumeAppliedAt: formatDateTime(row.resume_applied_at),
    cancelledAt: formatDateTime(row.cancelled_at),
  };
}

/**
 * @param {Record<string, unknown>} row
 */
export function mapSandboxAuditEvent(row) {
  return {
    auditId: String(row.audit_id),
    orgId: String(row.org_id),
    userId: String(row.user_id),
    eventType: String(row.event_type),
    sandboxSessionId:
      row.sandbox_session_id == null
        ? null
        : String(row.sandbox_session_id),
    executionId:
      row.execution_id == null ? null : String(row.execution_id),
    processId: row.process_id == null ? null : String(row.process_id),
    traceId: row.trace_id == null ? null : String(row.trace_id),
    payloadJson:
      row.payload_json == null ? null : parseJsonColumn(row.payload_json),
    createdAt: formatDateTime(row.created_at),
  };
}

/**
 * Format a Date or ISO string for MySQL DATETIME(3) UTC storage.
 * @param {Date | string} value
 * @returns {string}
 */
export function toMysqlDateTime(value) {
  let d;
  try {
    d = parseDateTimeAsUtc(value);
  } catch {
    throw new Error(`Invalid datetime for MySQL storage: ${String(value)}`);
  }
  // YYYY-MM-DD HH:mm:ss.sss (UTC)
  const iso = d.toISOString();
  return iso.slice(0, 23).replace('T', ' ');
}
