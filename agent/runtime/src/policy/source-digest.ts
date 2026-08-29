/**
 * 审批绑定字节而不是路径——skill_install(source=sandbox) 必须带 source_digest。
 *
 * 批准之后工作区可写，模型可以掉包。digest 对不上就拒绝，什么都没装。
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

export function assertSourceDigest(toolName: string, args: Record<string, unknown>): PolicyDecision | null {
  if (toolName !== 'skill_install') return null;
  if (String(args['source'] ?? 'attachment') !== 'sandbox') return null;
  const digest = String(args['source_digest'] ?? '');
  if (!SOURCE_DIGEST_RE.test(digest)) {
    return makePolicyDecision({
      decision: 'deny',
      reasonCode: 'SOURCE_DIGEST_REQUIRED',
      reason: 'skill_install source=sandbox requires source_digest (64 lowercase hex sha256)',
      policyId: 'platform:source-digest',
      riskLevel: 'high',
    });
  }
  return null;
}

/** 恢复重放：账本里的 digest 与本次参数不一致则拒绝。 */
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
