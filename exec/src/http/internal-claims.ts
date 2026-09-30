/**
 * HMAC claims attached to the current fetch Request after the internal middleware.
 *
 * 类型只声明**已经被下游读过**的字段，避免让「claims 里有什么」变成每个
 * handler 各自猜的事。`org_id` 是 2026-10-01 加上的：审核工作区策略
 * （`internal-session.ts`）要把策略记在发起人的 org 名下，而 org **只能**来自
 * 已校验的令牌 claims——请求体里的任何 org 字段都是调用方可控的。
 */
export const internalClaimsByRequest = new WeakMap<
  Request,
  {
    sandbox_session_id?: string;
    agent_session_id?: string;
    org_id?: string;
    user_id?: string;
    run_id?: string | null;
  }
>();
