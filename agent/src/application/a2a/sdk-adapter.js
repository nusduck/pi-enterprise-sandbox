/**
 * 把我们的 Run 事件翻译成 @a2a-js/sdk 类型。手写协议文件在 Wave 6 收口时删除，
 * 对外 SSE 帧改走 SDK 的 formatSSEEvent，避免再抄一份 data: JSON。
 */

import { formatSSEEvent } from '@a2a-js/sdk';
import { projectRunStatusToA2a } from '../../domain/a2a/status.js';

/**
 * @param {unknown} runStatus
 * @returns {string}
 */
export function mapRunStatusToSdkTaskState(runStatus) {
  return projectRunStatusToA2a(runStatus);
}

/**
 * @param {object} payload
 * @returns {string}
 */
export function encodeA2aSseFromSdk(payload) {
  return formatSSEEvent(payload);
}
