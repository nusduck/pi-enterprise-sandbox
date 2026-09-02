/**
 * 策略判定——单调收紧，不能被后续监听器翻案。
 *
 * 为什么单独一层：pre-execute / guard / 风险表都产出同一形状，
 * merge 必须是“只收紧不放松”，否则 Wave 1 那种条件式 fail-open 会再来一次。
 */

export const DECISIONS = ['allow', 'require_approval', 'deny'] as const;
export type PolicyDecisionKind = (typeof DECISIONS)[number];

export const RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
export type PolicyRiskLevel = (typeof RISK_LEVELS)[number];

export interface PolicyDecision {
  readonly decision: PolicyDecisionKind;
  readonly reasonCode: string;
  readonly reason: string;
  readonly policyId: string;
  readonly riskLevel: PolicyRiskLevel;
}

export const DECISION_RANK: Readonly<Record<PolicyDecisionKind, number>> = Object.freeze({
  allow: 0,
  require_approval: 1,
  deny: 2,
});

export const RISK_RANK: Readonly<Record<PolicyRiskLevel, number>> = Object.freeze({
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
});

export function makePolicyDecision(
  partial: Omit<PolicyDecision, 'riskLevel'> & { riskLevel?: PolicyRiskLevel },
): PolicyDecision {
  const riskLevel = partial.riskLevel ?? 'low';
  if (!DECISIONS.includes(partial.decision)) {
    throw new Error('invalid policy decision');
  }
  if (!RISK_LEVELS.includes(riskLevel)) {
    throw new Error('invalid risk level');
  }
  if (!partial.reasonCode.trim() || !partial.reason.trim() || !partial.policyId.trim()) {
    throw new Error('policy decision missing fields');
  }
  return {
    decision: partial.decision,
    reasonCode: partial.reasonCode.trim(),
    reason: partial.reason.trim(),
    policyId: partial.policyId.trim(),
    riskLevel,
  };
}

/** 合并：取更严的 decision 与更高的 risk。后续监听器不能把 deny 改成 allow。 */
export function mergePolicyDecisions(decisions: readonly PolicyDecision[]): PolicyDecision {
  if (decisions.length === 0) {
    return makePolicyDecision({
      decision: 'allow',
      reasonCode: 'DEFAULT_ALLOW',
      reason: 'no policy decisions',
      policyId: 'platform:default',
    });
  }
  let best = decisions[0]!;
  for (const next of decisions.slice(1)) {
    const tighterDecision = DECISION_RANK[next.decision] > DECISION_RANK[best.decision];
    const higherRisk = RISK_RANK[next.riskLevel] > RISK_RANK[best.riskLevel];
    if (tighterDecision || (next.decision === best.decision && higherRisk)) {
      best = {
        decision: tighterDecision ? next.decision : best.decision,
        reasonCode: tighterDecision ? next.reasonCode : best.reasonCode,
        reason: tighterDecision ? next.reason : best.reason,
        policyId: tighterDecision ? next.policyId : best.policyId,
        riskLevel: higherRisk ? next.riskLevel : best.riskLevel,
      };
    } else if (higherRisk) {
      best = { ...best, riskLevel: next.riskLevel };
    }
  }
  return best;
}
