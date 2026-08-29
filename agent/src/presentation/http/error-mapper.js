import {
  OwnerScopedNotFoundError,
  IdempotencyInProgressError,
  IdempotencyConflictError,
  ValidationError,
  CanonicalJsonError,
  ParentProvisioningRaceError,
} from '../../application/errors.js';

const NOT_FOUND_NOUNS = Object.freeze({
  conversations: 'Conversation',
  approvals: 'Approval',
  process_executions: 'Process',
  agent_sessions: 'Session',
  sandbox_sessions: 'Session',
  datasets: 'Dataset',
  trace_spans: 'Trace',
  interactions: 'Interaction',
  cron_jobs: 'Cron job',
  cron_job_runs: 'Cron job run',
});

export function mapErrorToHttp(error) {
  if (error instanceof ValidationError || error instanceof CanonicalJsonError) {
    return { status: 400, body: { error: error.message, code: error.code } };
  }
  if (error instanceof OwnerScopedNotFoundError) {
    // @ts-expect-error 遗留JSDoc未校验，存活代码先用expect-error收敛，Wave6前不改运行时 —— TS2538: Type 'unknown' cannot be used as an index type.
    const noun = NOT_FOUND_NOUNS[error.details?.resource] || 'Run';
    return { status: 404, body: { error: `${noun} not found`, code: 'NOT_FOUND' } };
  }
  if (error instanceof IdempotencyInProgressError) {
    return {
      status: 409,
      body: { error: error.message, code: error.code, retryable: true },
    };
  }
  if (error instanceof IdempotencyConflictError) {
    return { status: 409, body: { error: error.message, code: error.code } };
  }
  if (error instanceof ParentProvisioningRaceError) {
    return {
      status: 409,
      body: { error: 'Conflict; retry', code: error.code, retryable: true },
    };
  }

  const code = error?.code;
  const name = error?.name;
  if (code === 'INTERACTION_RESPONSE_INVALID') {
    return {
      status: 400,
      body: { error: 'Invalid interaction response', code },
    };
  }
  if (code === 'NOT_FOUND' || name === 'NotFoundError') {
    return { status: 404, body: { error: 'Not found', code: 'NOT_FOUND' } };
  }
  if (code === 'CONFLICT' || name === 'ConflictError') {
    return { status: 409, body: { error: 'Conflict', code: 'CONFLICT' } };
  }
  if (
    code === 'MYSQL_CONFIG_ERROR' ||
    code === 'REDIS_CONFIG_ERROR' ||
    name === 'MysqlConfigError' ||
    name === 'RedisConfigError'
  ) {
    return {
      status: 503,
      body: { error: 'Service configuration unavailable', code: 'CONFIG' },
    };
  }
  if (
    code === 'MYSQL_DEPENDENCY_ERROR' ||
    code === 'REDIS_DEPENDENCY_ERROR' ||
    code === 'SANDBOX_SESSION_PROVISION_FAILED' ||
    name === 'MysqlDependencyError' ||
    name === 'RedisDependencyError'
  ) {
    return {
      status: 503,
      body: { error: 'Service dependency unavailable', code: 'DEPENDENCY' },
    };
  }
  // Nothing claimed this error, so it becomes an opaque 500. Log it here —
  // the only place every unmapped failure passes through — otherwise the sole
  // record of a server-side bug is a bare "Internal server error" in the
  // browser, with no stack anywhere in the Agent's output.
  console.error('[agent-http] unmapped error →500:', error);
  return { status: 500, body: { error: 'Internal server error' } };
}

export function mapProcessErrorToHttp(error) {
  const mapped = mapErrorToHttp(error);
  if (mapped.status !== 500) return mapped;
  const status = Number(error?.status ?? error?.httpStatus);
  if (status === 400 || status === 422) {
    return {
      status: 400,
      body: { error: 'Invalid process request', code: 'INVALID_PROCESS_REQUEST' },
    };
  }
  if (status === 404) {
    return { status: 404, body: { error: 'Process not found', code: 'NOT_FOUND' } };
  }
  if (status === 409) {
    return {
      status: 409,
      body: { error: 'Process operation conflict', code: 'PROCESS_CONFLICT' },
    };
  }
  if (status === 503) {
    return {
      status: 503,
      body: { error: 'Process service unavailable', code: 'DEPENDENCY' },
    };
  }
  return mapped;
}
