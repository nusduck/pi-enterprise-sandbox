/**
 * 执行面传输失败的「结果未知」分类（2026-09-17，STATUS G2）。
 *
 * 真实 DSH gate 场景 4：命令执行中重启 sandbox，Agent 只拿到 `fetch failed`，工具
 * 记 FAILED，模型把它当普通失败继续——可命令可能已经执行了一部分，模型一重试就是
 * 重复副作用。Pi 时代的设计是记 UNKNOWN、不自动重试；这里在 DSH 下把它补回来。
 *
 * 只有同时满足两条才算未知：
 * 1. **路由有副作用**。只读路由重试无害，按普通失败处理，免得一次读失败就让后续
 *    崩溃恢复落到人工对账。
 * 2. **请求可能已送达**。连接根本没建立（拒绝连接、DNS 失败、连接超时）说明执行面
 *    没收到请求，是确定的失败；调用方主动取消另有「断连即停止」的保证（审查 R2），
 *    也不算未知。其余传输异常——连接被重置、对端关闭、传输截止到期——都可能发生在
 *    命令已经开始之后。
 */

import { markCurrentToolOutcomeUnknown } from './tool-execution-context.js';

/** 会改变工作区或登记状态的内部面路由。 */
const SIDE_EFFECT_ROUTES: ReadonlySet<string> = new Set([
  '/internal/v1/shell/run',
  '/internal/v1/shell/start',
  '/internal/v1/fs/write-text',
  '/internal/v1/fs/edit-text',
  '/internal/v1/artifacts/submit',
]);

/** 请求没有送达执行面的连接期错误码（Node / undici）。 */
const NOT_DELIVERED_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

function transportCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current !== null && typeof current === 'object'; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * 判定一次失败的 RPC 是否结果未知；是则标记当前工具调用并返回给模型的说明，否则返回 null。
 *
 * @param deadlineHit 传输截止定时器是否已触发（区别于调用方取消）
 */
export function classifyExecOutcomeUnknown(
  htu: string,
  err: unknown,
  state: { deadlineHit: boolean; callerAborted: boolean },
): string | null {
  if (!SIDE_EFFECT_ROUTES.has(htu) || state.callerAborted) return null;
  const code = state.deadlineHit ? 'deadline' : transportCode(err) ?? 'transport';
  if (NOT_DELIVERED_CODES.has(code)) return null;
  markCurrentToolOutcomeUnknown(code);
  return (
    `The sandbox connection was lost after the request was sent (${code}), so this ` +
    'operation may or may not have taken effect — it may have partially run. ' +
    'Inspect the workspace state before retrying; do not blindly repeat it.'
  );
}
