/**
 * 审批绑定**字节**而不是路径：人点同意之后、工具真正落地之前，参数指纹对不上就拒绝。
 *
 * ## 2026-08-31 退役了一半（ADR 0009 D7 / 计划 H6.8）
 *
 * 原来这里还有一个 `assertSourceDigest()`，专门要求 `skill_install(source=sandbox)`
 * 带 `source_digest`。D7 取消了整套 skill 变更工具（模型改用 `write`/`bash` 写草稿目录，
 * 闸门移到 UI 上的「启用」），那条校验连同它服务的「审批后重放 zip」路径一起没了。
 *
 * **但本文件不能整个删**——ADR D7 的「一并退役 `source-digest.ts`」写宽了。
 * `digestArgs()` 与 `rejectMismatchedDigest()` 是 **D5 审批续跑**的承重件：
 * `pre-execute` 铸 PENDING 时记的 `sourceDigest` 就是它算的，重放时靠它挡住
 * 「批准的是 A、落地的是 B」。删掉等于把 D5 的指纹校验一起删了。
 */

import { createHash } from 'node:crypto';
import { makePolicyDecision, type PolicyDecision } from './decision.js';

export const SOURCE_DIGEST_RE = /^[a-f0-9]{64}$/;

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortValue);
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = sortValue(obj[k]);
  return out;
}

export function digestArgs(args: unknown): string {
  return createHash('sha256').update(canonicalJson(args ?? {}), 'utf8').digest('hex');
}

/**
 * 续跑重放：已批准记录里的参数指纹与本次实际参数不一致则拒绝（ADR 0009 D5）。
 *
 * 理由码保持 `SOURCE_DIGEST_MISMATCH` 不变——它是对外稳定的理由码，审批中心与
 * 前端都认它；这次退役的是 `skill_install` 那条专用校验，不是这条通用的。
 */
export function rejectMismatchedDigest(expected: string, actual: string): PolicyDecision | null {
  if (expected === actual) return null;
  return makePolicyDecision({
    decision: 'deny',
    reasonCode: 'SOURCE_DIGEST_MISMATCH',
    reason: `source_digest mismatch: expected ${expected}, found ${actual}`,
    policyId: 'platform:source-digest',
    riskLevel: 'high',
  });
}
