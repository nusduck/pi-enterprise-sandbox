/**
 * A2A 请求/错误映射。从 http-handler 抽出来的纯函数——它们不闭包 `deps`，
 * 只做「方法名→scope」「异常→JSON-RPC error」这类查表，放在一起既让
 * http-handler 回到路由本身，也让这几张表可以单独读。
 */

import { A2A_SCOPES } from '../../domain/a2a/scopes.js';
import { A2aAuthError } from '../../application/a2a/credential-service.js';
import { A2aTaskError, A2aAuditError } from '../../application/a2a/task-service.js';
import {
  A2A_METHODS,
  A2A_RPC_ERROR,
  JSON_RPC_ERROR,
} from '../../application/a2a/json-rpc.js';
import { ValidationError } from '../../application/errors.js';

export function requiredScopeForMethod(method: string): string {
  switch (method) {
    case A2A_METHODS.SEND_MESSAGE:
    case A2A_METHODS.SEND_STREAMING_MESSAGE:
      return A2A_SCOPES.INVOKE;
    case A2A_METHODS.GET_TASK:
    case A2A_METHODS.SUBSCRIBE_TO_TASK:
    case A2A_METHODS.LIST_TASKS:
      return A2A_SCOPES.READ;
    case A2A_METHODS.CANCEL_TASK:
      return A2A_SCOPES.CANCEL;
    default:
      return A2A_SCOPES.READ;
  }
}

export function readA2aVersionHeader(req: {
  headers: Record<string, string | string[] | undefined>;
}): string | null {
  const raw =
    req.headers['a2a-version'] ||
    req.headers['A2A-Version'] ||
    req.headers['A2A-VERSION'];
  if (typeof raw !== 'string' || !raw.trim()) return null;
  // Take first token if comma-separated negotiation list.
  return raw.split(',')[0].trim();
}

export function extractTaskId(params: any): string {
  const id =
    params?.id ??
    params?.taskId ??
    params?.task_id ??
    (params?.task && typeof params.task === 'object'
      ? params.task.id
      : null);
  if (typeof id !== 'string' || !id.trim()) {
    throw new ValidationError('params.id (task id) is required');
  }
  return id.trim();
}

export function mapA2aErrorToRpc(err: unknown) {
  if (err instanceof A2aTaskError && err.rpc) {
    return {
      code: err.rpc.code,
      message: err.rpc.message,
      data: { code: err.code },
    };
  }
  if (err instanceof A2aAuditError) {
    return {
      ...JSON_RPC_ERROR.INTERNAL,
      data: { code: err.code },
    };
  }
  if (err instanceof A2aAuthError) {
    return {
      ...A2A_RPC_ERROR.AUTH,
      data: { code: err.code },
    };
  }
  if (err instanceof ValidationError) {
    return {
      ...JSON_RPC_ERROR.INVALID_PARAMS,
      data: { reason: err.message, code: err.code },
    };
  }
  const code = (err as { code?: string } | null)?.code;
  if (code === 'NOT_FOUND') {
    return { ...A2A_RPC_ERROR.TASK_NOT_FOUND };
  }
  return { ...JSON_RPC_ERROR.INTERNAL };
}
