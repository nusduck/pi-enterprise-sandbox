/**
 * PolicyDecision helpers (plan §14.3).
 */

/** @typedef {'allow' | 'deny' | 'require_approval'} PolicyDecisionKind */
/** @typedef {'low' | 'medium' | 'high' | 'critical'} PolicyRiskLevel */

/**
 * @typedef {{
 *   decision: PolicyDecisionKind,
 *   reasonCode: string,
 *   reason: string,
 *   policyId: string,
 *   riskLevel: PolicyRiskLevel,
 * }} PolicyDecision
 */

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
 * @param {unknown} value
 * @returns {PolicyDecision | null}
 */
export function validatePolicyDecision(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const d = /** @type {Record<string, unknown>} */ (value);
  if (!DECISIONS.includes(/** @type {any} */ (d.decision))) return null;
  if (typeof d.reasonCode !== 'string' || !d.reasonCode.trim()) return null;
  if (typeof d.reason !== 'string' || !d.reason.trim()) return null;
  if (typeof d.policyId !== 'string' || !d.policyId.trim()) return null;
  if (!RISK_LEVELS.includes(/** @type {any} */ (d.riskLevel))) return null;
  return {
    decision: /** @type {PolicyDecisionKind} */ (d.decision),
    reasonCode: d.reasonCode.trim(),
    reason: d.reason.trim(),
    policyId: d.policyId.trim(),
    riskLevel: /** @type {PolicyRiskLevel} */ (d.riskLevel),
  };
}

/**
 * @param {Partial<PolicyDecision> & { decision: PolicyDecisionKind, reasonCode: string, reason: string, policyId: string }} partial
 * @returns {PolicyDecision}
 */
export function makePolicyDecision(partial) {
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
 * @param {PolicyDecision[]} decisions — higher priority first
 * @returns {PolicyDecision}
 */
export function mergePolicyDecisions(decisions) {
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
