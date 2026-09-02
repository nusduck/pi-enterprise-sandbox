/**
 * 把我们的 Run 事件翻译成 @a2a-js/sdk 的词汇。
 *
 * **范围仅限帧编码。** 这里只接了 SDK 的 `formatSSEEvent`，省掉再抄一份
 * `data: <json>\n\n`。ADR 0007 D8 说的「12 个手写协议文件作废」**没有发生**：
 * JSON-RPC、凭据、Task↔Run、SSE 投影仍是本目录与 presentation/a2a 下的自建实现，
 * `@a2a-js/sdk/server`（A2ARequestHandler / TaskStore / ExecutionEventBus）
 * 全仓零 import。别照着旧注释以为协议面已经归 SDK 了。
 * 工单：docs/design/a2a-sdk-server.md
 */

import { formatSSEEvent } from '@a2a-js/sdk';
import { projectRunStatusToA2a } from '../../domain/a2a/status.js';

/**
 * @param runStatus
 * @returns {string}
 */
export function mapRunStatusToSdkTaskState(runStatus: unknown) {
  return projectRunStatusToA2a(runStatus);
}

/**
 * @param payload
 * @returns {string}
 */
export function encodeA2aSseFromSdk(payload: Record<string, any>) {
  return formatSSEEvent(payload);
}
