/**
 * Agent <-> Exec 内部 RPC 信封。
 *
 * 为什么每个内部请求都要带这五个字段：
 * - `requestId`     一次调用的唯一标识，用于日志关联与幂等排查。
 * - `workspaceId`   **多实例一致性哈希路由的预留键**（ADR 0008 D5）。
 *                    exec 现在是单进程部署，这个字段今天不参与任何路由
 *                    判断；但接口现在就把它定成必填字段，是为了以后把
 *                    exec 拆成多实例、按 workspaceId 做一致性哈希路由时，
 *                    不用改一次内部契约——历史请求日志里也全都能查到。
 *                    **不允许把它做成可选字段**，那样等于把"以后要不要
 *                    加路由"这个决定悄悄下放给了每一个调用方。
 * - `orgId`/`userId` 租户上下文，所有内部端点必须据此做归属校验。
 * - `fenceToken`    execution fence token（单调递增），配合 ADR 里的
 *                    "过期即拒绝"语义，防止一次 Run 过期后的孤儿请求
 *                    还能继续操作工作区。
 *
 * 这份信封本身完全独立于 HMAC 令牌（`hmac.ts`）：令牌证明"这个请求确实
 * 来自 Agent 服务、确实绑定这个 HTTP 方法/路径/请求体"，信封证明"这个
 * 请求要落到哪个租户、哪个工作区、哪一次 Run"。两者字段有重叠
 * （org_id/user_id/agent_session_id 等）不是巧合——调用方在两处都要填，
 * 服务端在两处都要校验，二者不一致时必须拒绝（这是 exec 侧内部端点的
 * 职责，不在这个模块里做，因为这里拿不到已解码的令牌 claims）。
 *
 * 信封来自网络，不能只信 TypeScript 的编译期类型——`assertEnvelope` 是
 * 运行时校验，供 exec 的 HTTP 处理器在反序列化请求体之后立刻调用。
 */

import { ContractError } from './errors.js';
import type { WireError } from './errors.js';

/** 每个内部请求必须携带的信封。 */
export interface RpcEnvelope {
  readonly requestId: string;
  /** 多实例一致性哈希路由的预留键（ADR 0008 D5）；必填，不是可选字段。 */
  readonly workspaceId: string;
  readonly orgId: string;
  readonly userId: string;
  /** execution fence token；单调递增，用于拒绝过期 Run 的孤儿请求。 */
  readonly fenceToken: number;
}

/** 带信封的一次内部请求。 */
export interface RpcRequest<T> {
  readonly envelope: RpcEnvelope;
  readonly payload: T;
}

/** 成功的 RPC 响应。 */
export interface RpcSuccess<T> {
  readonly ok: true;
  readonly data: T;
}

/** 失败的 RPC 响应；`error` 的形状见 `errors.ts` 的 `WireError`。 */
export interface RpcFailure {
  readonly ok: false;
  readonly error: WireError;
}

/** 统一的 RPC 响应包装：成功带 `data`，失败带脱敏后的 `error`。 */
export type RpcResult<T> = RpcSuccess<T> | RpcFailure;

/** 构造成功响应。 */
export function okResult<T>(data: T): RpcSuccess<T> {
  return { ok: true, data };
}

/** 构造失败响应。 */
export function errResult(error: WireError): RpcFailure {
  return { ok: false, error };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * 非负安全整数校验——fence token 是单调递增的序号，允许从 0 起算。
 */
function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * 运行时校验一个反序列化后的值是否是合法的 {@link RpcEnvelope}。
 *
 * 信封来自网络，`as RpcEnvelope` 这种编译期断言只能骗过类型检查器，骗不了
 * 一个真的缺字段/错类型的请求体——所以这里逐字段显式检查，而不是信任
 * 上游已经校验过。失败时抛 `ContractError('ENVELOPE_INVALID', ...)`，
 * 消息里只描述"哪个字段不对"，不回显信封原始内容（避免把调用方拼错的
 * 内容原样回显造成的注入/日志污染面）。
 */
export function assertEnvelope(value: unknown): asserts value is RpcEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ContractError('ENVELOPE_INVALID', 'envelope must be an object');
  }
  const candidate = value as Record<string, unknown>;

  if (!isNonEmptyString(candidate.requestId)) {
    throw new ContractError('ENVELOPE_INVALID', 'envelope.requestId must be a non-empty string');
  }
  if (!isNonEmptyString(candidate.workspaceId)) {
    throw new ContractError('ENVELOPE_INVALID', 'envelope.workspaceId must be a non-empty string');
  }
  if (!isNonEmptyString(candidate.orgId)) {
    throw new ContractError('ENVELOPE_INVALID', 'envelope.orgId must be a non-empty string');
  }
  if (!isNonEmptyString(candidate.userId)) {
    throw new ContractError('ENVELOPE_INVALID', 'envelope.userId must be a non-empty string');
  }
  if (!isNonNegativeSafeInteger(candidate.fenceToken)) {
    throw new ContractError(
      'ENVELOPE_INVALID',
      'envelope.fenceToken must be a non-negative safe integer',
    );
  }
}

/**
 * 校验并返回一个信封（便于 `const envelope = parseEnvelope(body.envelope)`
 * 这种一行式用法，而不用先声明变量再调用 `assertEnvelope`）。
 */
export function parseEnvelope(value: unknown): RpcEnvelope {
  assertEnvelope(value);
  return value;
}
