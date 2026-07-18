/**
 * Agent Redis coordination primitives (PR-03 slice A).
 *
 * Runtime coordination only: leases, cancel signals, event streams, BullMQ run queue.
 * MySQL remains the fact store. No Outbox publisher in this slice.
 */

export {
  createRedisClient,
  createBullMQConnection,
  destroyRedisClient,
  assertRedisConnectionUrl,
  assertIoredisInstalled,
  assertBullmqInstalled,
  loadIoredisModule,
  loadBullmqModule,
  describeRejectedRedisUrl,
} from './client.js';

export {
  attachRedisConnectionErrorGuard,
  createConnectionErrorGuard,
  classifyRedisConnectionError,
  sanitizeRedisLogText,
  hasRedisConnectionErrorGuard,
  REDIS_ERROR_GUARD_CLEANUP,
} from './redis-connection-error-guard.js';

export {
  LEASE_TTL_MS,
  LEASE_RENEW_INTERVAL_MS,
  RUN_STREAM_MAXLEN,
  CANCEL_SIGNAL_TTL_MS,
  AGENT_RUNS_QUEUE_NAME,
  OUTBOX_WAKEUP_KEY,
  RUN_JOB_REF_FIELDS,
  SESSION_LOCK_TTL_MS,
  SESSION_LOCK_RENEW_INTERVAL_MS,
  runLeaseKey,
  runCancelKey,
  runStreamKey,
  sessionLockKey,
} from './constants.js';

export {
  RedisConfigError,
  RedisDependencyError,
  RedisValidationError,
  LeaseError,
  SessionLockError,
} from './errors.js';

export {
  ULID_PATTERN,
  TRACE_ID_PATTERN,
  ISO8601_UTC_PATTERN,
  OWNER_TOKEN_MAX_LEN,
  EVENT_TYPE_MAX_LEN,
  RUN_STREAM_PAYLOAD_MAX_BYTES,
  isUlid,
  assertUlid,
  assertRunId,
  assertAgentSessionId,
  assertOrgId,
  assertEventId,
  isTraceId,
  assertTraceId,
  assertOwnerToken,
  assertSequence,
  assertEventType,
  isIso8601Utc,
  assertCreatedAtUtc,
  assertStreamPayload,
} from './validation.js';

export { LeaseManager, RENEW_LUA, RELEASE_LUA } from './lease-manager.js';

export {
  SessionLockManager,
  createSerialRenewLoop,
  generateSessionLockOwnerToken,
  SESSION_LOCK_RENEW_LUA,
  SESSION_LOCK_RELEASE_LUA,
} from './session-lock-manager.js';

export {
  RunEventStream,
  validateRunStreamEvent,
  parseStreamEntry,
} from './run-event-stream.js';

export { CancelSignal } from './cancel-signal.js';

export {
  assertRunJobRef,
  createRunQueue,
  createRunWorker,
  enqueueRunJob,
  destroyRunQueue,
  destroyRunWorker,
} from './run-queue.js';
