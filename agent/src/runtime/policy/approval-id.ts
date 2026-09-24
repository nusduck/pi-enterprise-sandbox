/**
 * 审批记录 id 的构造规则——**只有这一处**。
 *
 * `tools/pre-execute` 铸 PENDING 时用它生成 id，`approval/request` 的 answerer
 * 用它回查。分头拼字符串就是「同一件事两处各算一遍」，而且不一致时的症状是
 * 「审批永远查不到、每次都返回拒绝」——没有任何人报错，只是审批功能整体失效。
 */
export function approvalIdOf(callId: string): string {
  return `appr_${callId}`;
}

/** `approvalIdOf` 的逆运算；不是本规则铸出的 id 返回 `undefined`。 */
export function callIdOfApprovalId(approvalId: string): string | undefined {
  return approvalId.startsWith('appr_') && approvalId.length > 5 ? approvalId.slice(5) : undefined;
}
