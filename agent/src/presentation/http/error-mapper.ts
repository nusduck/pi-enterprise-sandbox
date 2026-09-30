/**
 * 领域错误 → HTTP 状态与响应体。阶段 C 的 TS 转换。
 *
 * 这是**唯一**把内部错误翻成对外响应的地方。两条纪律：
 * - 认不出来的错误一律 500 + 通用文案，**绝不**把 message 透给调用方
 * - 但那种情况必须记日志：否则一个服务端 bug 在世上唯一的痕迹就是浏览器里
 *   一句 "Internal server error"，Agent 的输出里连栈都没有
 */
import {
  ActiveVersionConflictError,
  AdminRoleRequiredError,
  OwnerScopedNotFoundError,
  IdempotencyInProgressError,
  IdempotencyConflictError,
  ValidationError,
  CanonicalJsonError,
  ParentProvisioningRaceError,
} from '../../application/errors.js';

/** 资源名 → 对外的名词。查不到时用 'Run'（最常见的资源）。 */
const NOT_FOUND_NOUNS: Readonly<Record<string, string>> = Object.freeze({
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
  agent_definitions: 'Agent',
  agent_versions: 'Agent version',
});

/** 对外响应：状态码 + 响应体。 */
export interface HttpErrorResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

/** 领域错误常见的两个鸭子字段。用最小结构，不假设具体的错误类。 */
interface ErrorLike {
  readonly code?: unknown;
  readonly name?: unknown;
  readonly status?: unknown;
  readonly httpStatus?: unknown;
  readonly details?: { readonly resource?: unknown; readonly code?: unknown } | undefined;
}

/**
 * 具体的诊断码（`details.code`），与通用的 `VALIDATION_ERROR` **并存**。
 *
 * 为什么需要它：`ValidationError` 的 `code` 一直是通用的 `VALIDATION_ERROR`，而各
 * 写入路径早就把具体原因放进了 `details`（`DELEGATION_AGENT_UNKNOWN`、
 * `CONFIG_INVALID`…）。在此之前那枚码**没有任何出口**——浏览器只看到「参数非法」，
 * 拿不到「哪个字段为什么」。AGENTS.md §3 要求无效字段必须明确诊断，所以把它挂成
 * `reason_code`，而不是改 `code`：`code` 是对外已文档化的稳定值，换掉它是破坏性
 * 变更（`docs/api.md`）。
 */
function reasonCodeOf(error: unknown): string | null {
  const code = (error as ErrorLike)?.details?.code;
  return typeof code === 'string' && code !== '' ? code : null;
}

/** 需要带上 `reason_code` 的错误体（只在真有具体码时加字段）。 */
function withReason(
  error: unknown,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const reason = reasonCodeOf(error);
  return reason !== null && reason !== body['code']
    ? { ...body, reason_code: reason }
    : body;
}

export function mapErrorToHttp(error: unknown): HttpErrorResponse {
  if (error instanceof ValidationError || error instanceof CanonicalJsonError) {
    return {
      status: 400,
      body: withReason(error, { error: error.message, code: error.code }),
    };
  }
  if (error instanceof AdminRoleRequiredError) {
    return { status: 403, body: { error: error.message, code: error.code } };
  }
  if (error instanceof OwnerScopedNotFoundError) {
    // 转 TS 时顺手去掉了这里的 @ts-expect-error：把 NOT_FOUND_NOUNS 声明成
    // Record<string, string> 之后，只需要把 resource 收窄成 string 即可。
    const resource = (error as ErrorLike).details?.resource;
    const noun = (typeof resource === 'string' ? NOT_FOUND_NOUNS[resource] : undefined) || 'Run';
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
  if (error instanceof ActiveVersionConflictError) {
    // The current pointer travels with the 409 so the client can show the
    // difference instead of retrying blind over someone else's activation.
    return {
      status: 409,
      body: {
        error: error.message,
        code: error.code,
        active_version_id: error.currentActiveVersionId,
      },
    };
  }
  if (error instanceof ParentProvisioningRaceError) {
    return {
      status: 409,
      body: { error: 'Conflict; retry', code: error.code, retryable: true },
    };
  }

  const err = (error ?? {}) as ErrorLike;
  const code = err.code;
  const name = err.name;
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
