/**
 * Application services (plan §12.1) — PR-04 T2 Create/Get/Cancel + T3 Execute/Recovery.
 * No live HTTP/worker wiring on import; consumers inject repositories + queue/signal/lease.
 */

export {
  ApplicationError,
  ParentProvisioningRaceError,
  IdempotencyInProgressError,
  IdempotencyConflictError,
  OwnerScopedNotFoundError,
  ValidationError,
  CanonicalJsonError,
} from './errors.js';

export {
  canonicalize,
  stableStringify,
  sha256Hex,
  hashCanonical,
  hashCreateRunRequest,
  DEFAULT_MAX_CANONICAL_BYTES,
  DEFAULT_MAX_MESSAGES,
  DEFAULT_MAX_MESSAGE_CHARS,
} from './canonical-json.js';

export {
  ExternalIdentityResolver,
  DEFAULT_EXTERNAL_PROVIDER,
  requireExternalSubject,
  assertNotExternalInUlidSlot,
} from './parent/external-identity-resolver.js';

export { RunParentProvisioner } from './parent/run-parent-provisioner.js';

export {
  CreateRunService,
  CREATE_RUN_OPERATION,
  DEFAULT_IDEMPOTENCY_TTL_MS,
  DEFAULT_MAX_PROVISION_RETRIES,
  QUEUE_WARNING,
  buildEventsUrl,
  normalizeTraceId,
} from './create-run-service.js';

export { GetRunService } from './get-run-service.js';

export {
  ApprovalQueryService,
  presentApproval,
} from './approval-query-service.js';

export { ApprovalDecisionService } from './approval-decision-service.js';

export { InteractionResponseService } from './interaction-response-service.js';

export { CancelRunService } from './cancel-run-service.js';

export {
  SteerRunService,
  STEER_RUN_OPERATION,
  STEER_REQUESTED_EVENT,
  STEER_DELIVERED_EVENT,
  DEFAULT_STEER_IDEMPOTENCY_TTL_MS,
  MAX_STEER_TEXT_CHARS,
} from './steer-run-service.js';

export { FollowUpService } from './follow-up-service.js';

export {
  DurableSteerController,
  DEFAULT_STEER_POLL_INTERVAL_MS,
  STEER_EVENT_PAGE_SIZE,
  steerTextFromMessage,
} from './durable-steer-controller.js';

export {
  ExecuteRunService,
  LeaseBusyError,
  createSerialTimeoutLoop,
  DEFAULT_CANCEL_POLL_INTERVAL_MS,
} from './execute-run-service.js';

export {
  RunRecoveryService,
  RequeueService,
  RECOVERY_ENQUEUE_STATUSES,
  RECOVERY_RECONCILE_STATUSES,
} from './run-recovery-service.js';

export {
  createStubRunExecutor,
  normalizeExecutorResult,
} from './run-executor.js';

export {
  PiRunExecutor,
  createPiRunExecutorFactory,
  generateRunLeaseOwnerToken,
  derivePromptFromTriggeringMessage,
  createPromiseTail,
  FencedRunEventRecorder,
  FencedToolGovernanceRecorder,
  buildCanonicalEnvelope,
  redactEventData,
} from './pi-run-executor.js';

export {
  DurablePolicyConflictError,
  assertCompatiblePolicyReplay,
} from './fenced-tool-governance-recorder.js';

export {
  SandboxRequestBinder,
  computeSandboxToolRequestHash,
  binderPortFromRecorder,
} from './sandbox-request-binder.js';

export {
  SessionRecoveryService,
  buildProtectedManifestEntry,
  findProtectedManifest,
  emptySessionPayload,
  PLATFORM_MANIFEST_CUSTOM_TYPE,
} from './session-recovery-service.js';

export { applyRunTransitionInTxn } from './run-transition.js';

export {
  sanitizeStatusReason,
  STATUS_REASON_MAX_LEN,
} from './sanitize-status-reason.js';

export {
  RunEventQueryService,
  projectRunEventToSseEnvelope,
} from './run-event-query-service.js';

export {
  RunEventSseService,
  formatSseDataFrame,
  formatSsePingFrame,
  formatSseEndFrame,
  projectRedisStreamToSseEnvelope,
  resolveSseAfterSequence,
  shouldEmitSequence,
  DEFAULT_SSE_POLL_MS,
  DEFAULT_SSE_HEARTBEAT_MS,
  DEFAULT_MYSQL_CATCHUP_MS,
  DEFAULT_MYSQL_OPEN_RETRY_ATTEMPTS,
  DEFAULT_HISTORY_PAGE,
} from './run-event-sse-service.js';

export {
  A2aCredentialService,
  A2aAuthError,
  A2aTaskService,
  A2aTaskError,
  A2aStreamService,
  buildAgentCard,
  resolvePublicBaseUrl,
  parseJsonRpcRequest,
  jsonRpcSuccess,
  jsonRpcError,
  projectEnvelopeToA2aResult,
  buildA2aTaskObject,
} from './a2a/index.js';
