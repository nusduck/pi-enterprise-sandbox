/**
 * PolicyDecision helpers (plan §14.3).
 */

export type PolicyDecisionKind = 'allow' | 'deny' | 'require_approval';
export type PolicyRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export type PolicyDecision = {
  decision: PolicyDecisionKind;
  reasonCode: string;
  reason: string;
  policyId: string;
  riskLevel: PolicyRiskLevel;
};

export const DECISIONS = Object.freeze(['allow', 'deny', 'require_approval']);
export const RISK_LEVELS = Object.freeze(['low', 'medium', 'high', 'critical']);

const DECISION_RANK = Object.freeze({
  allow: 0,
  require_approval: 1,
  deny: 2,
});

const RISK_RANK = Object.freeze({
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
});

/**
 * @param value
 * @returns {PolicyDecision | null}
 */
export function validatePolicyDecision(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const d = (value as Record<string, unknown>);
  if (!DECISIONS.includes((d.decision as any))) return null;
  if (typeof d.reasonCode !== 'string' || !d.reasonCode.trim()) return null;
  if (typeof d.reason !== 'string' || !d.reason.trim()) return null;
  if (typeof d.policyId !== 'string' || !d.policyId.trim()) return null;
  if (!RISK_LEVELS.includes((d.riskLevel as any))) return null;
  return {
    decision: (d.decision as PolicyDecisionKind),
    reasonCode: d.reasonCode.trim(),
    reason: d.reason.trim(),
    policyId: d.policyId.trim(),
    riskLevel: (d.riskLevel as PolicyRiskLevel),
  };
}

/**
 * @param partial
 * @returns {PolicyDecision}
 */
export function makePolicyDecision(partial: Partial<PolicyDecision> & { decision: PolicyDecisionKind, reasonCode: string, reason: string, policyId: string }) {
  const d = validatePolicyDecision({
    riskLevel: 'low',
    ...partial,
  });
  if (!d) {
    throw new Error('makePolicyDecision produced invalid PolicyDecision');
  }
  return d;
}

/**
 * Merge decisions: never relax — max(decision rank), max(risk rank).
 * Lower layers cannot override a stricter upper-layer decision.
 * @param decisions — higher priority first
 * @returns {PolicyDecision}
 */
export function mergePolicyDecisions(decisions: PolicyDecision[]) {
  if (!decisions.length) {
    return makePolicyDecision({
      decision: 'deny',
      reasonCode: 'POLICY_EMPTY',
      reason: 'no policy decision available',
      policyId: 'platform:default',
      riskLevel: 'critical',
    });
  }
  let best = decisions[0];
  for (let i = 1; i < decisions.length; i += 1) {
    const cur = decisions[i];
    const dRank = DECISION_RANK[cur.decision];
    const bRank = DECISION_RANK[best.decision];
    if (dRank > bRank) {
      best = {
        ...cur,
        riskLevel:
          RISK_RANK[cur.riskLevel] >= RISK_RANK[best.riskLevel]
            ? cur.riskLevel
            : best.riskLevel,
      };
      continue;
    }
    if (dRank === bRank && RISK_RANK[cur.riskLevel] > RISK_RANK[best.riskLevel]) {
      best = { ...best, riskLevel: cur.riskLevel };
    }
  }
  return best;
}

export { DECISION_RANK, RISK_RANK };
