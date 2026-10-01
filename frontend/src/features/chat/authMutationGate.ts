/**
 * 认证 mutation 串行闸门（独立于 React，可单测）。
 *
 * 为什么需要它：login/register/logout 都会写服务端的 HttpOnly 会话 Cookie。
 * 两次认证写请求并发时，响应落地顺序与 Cookie 落地顺序可能相反——即使前端按
 * 身份代次丢弃了过期响应，**Cookie 早已被过期请求改写**，丢弃响应也救不回来。
 * 因此这三个 mutation 必须在同一互斥区段内串行：前一个（无论成功失败）结束，
 * 后一个才开始，快照取值 / HTTP 调用 / 身份落地都在同一段里完成。
 *
 * 语义：
 * - 同一时刻至多一个任务在跑；
 * - 严格 FIFO；
 * - 前一个任务失败不阻塞后一个（错误原样抛给该任务的调用方）。
 */
export type AuthMutationGate = {
  /**
   * 排队执行一个认证写操作。返回值/异常原样透传给调用方；无论前一个任务
   * 成功还是失败，下一个任务都会继续。
   */
  run<T>(task: () => Promise<T>): Promise<T>;
  /** 排队 + 运行中的任务数（诊断与测试用）。 */
  pending(): number;
};

export function createAuthMutationGate(): AuthMutationGate {
  let tail: Promise<void> = Promise.resolve();
  let pending = 0;

  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      pending += 1;
      // 前一个任务的结果/异常都不进入本任务；只借用它「已结束」的信号。
      const result = tail.then(
        () => task(),
        () => task(),
      );
      // 链尾永远 resolve：一次认证失败不能卡死后续登录/退出。
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      result.then(
        () => { pending -= 1; },
        () => { pending -= 1; },
      );
      return result;
    },
    pending: () => pending,
  };
}
