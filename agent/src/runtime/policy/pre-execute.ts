/**
 * tools/pre-execute：风险表 + source_digest + 持久 PENDING 审批。
 *
 * 只读参数，不改写（上游限制）。require_approval 时工具不得执行，
 * 账本先落 PENDING，Run 投影 WAITING_APPROVAL。
 */

import { makePolicyDecision, mergePolicyDecisions, type PolicyDecision } from './decision.js';
import type { PolicyRiskLevel } from './decision.js';
import { decideFromRiskTable } from './risk-table.js';
import { assertSourceDigest, digestArgs, rejectMismatchedDigest } from './source-digest.js';

export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'DENIED';

export interface PendingApproval {
  readonly id: string;
  readonly toolName: string;
  readonly sourceDigest: string;
  readonly argsCanonical: string;
  readonly status: ApprovalStatus;
  readonly runStatusHint: 'WAITING_APPROVAL';
}

export interface ApprovalStore {
  persistPending(record: PendingApproval): Promise<void>;
  get(id: string): Promise<PendingApproval | null>;
}

export class InMemoryApprovalStore implements ApprovalStore {
  readonly records = new Map<string, PendingApproval>();
  async persistPending(record: PendingApproval): Promise<void> {
    this.records.set(record.id, record);
  }
  async get(id: string): Promise<PendingApproval | null> {
    return this.records.get(id) ?? null;
  }
}

export interface PreExecuteInput {
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly callId: string;
  /** 恢复重放时带上当初入账的 digest；缺省表示首次。 */
  readonly replayDigest?: string | undefined;
}

export interface PreExecuteResult {
  readonly decision: PolicyDecision;
  readonly approval: PendingApproval | null;
  readonly blocked: boolean;
}

export async function evaluatePreExecute(
  input: PreExecuteInput,
  store: ApprovalStore,
  idFactory: () => string = () => `appr_${input.callId}`,
  /** 运维可配的风险覆盖（`TOOL_RISK_POLICY_JSON` / `TOOL_RISK_POLICY_PATH`）。
   *  不传就只用平台默认表——但那样运维配的东西就静默失效了，所以装配处必须传。 */
  riskOverrides: Readonly<Record<string, PolicyRiskLevel>> = {},
): Promise<PreExecuteResult> {
  const digest = digestArgs(input.args);
  const pieces: PolicyDecision[] = [decideFromRiskTable(input.toolName, riskOverrides)];
  const digestDecision = assertSourceDigest(input.toolName, input.args);
  if (digestDecision) pieces.push(digestDecision);
  if (input.replayDigest !== undefined) {
    const mismatch = rejectMismatchedDigest(input.replayDigest, digest);
    if (mismatch) pieces.push(mismatch);
  }
  const decision = mergePolicyDecisions(pieces);
  if (decision.decision === 'allow') {
    return { decision, approval: null, blocked: false };
  }
  if (decision.decision === 'deny') {
    return { decision, approval: null, blocked: true };
  }
  const approval: PendingApproval = {
    id: idFactory(),
    toolName: input.toolName,
    sourceDigest: digest,
    argsCanonical: JSON.stringify(input.args),
    status: 'PENDING',
    runStatusHint: 'WAITING_APPROVAL',
  };
  await store.persistPending(approval);
  return { decision, approval, blocked: true };
}

export function approvalRequiredDecision(toolName: string): PolicyDecision {
  return makePolicyDecision({
    decision: 'require_approval',
    reasonCode: 'RISK_HIGH',
    reason: `${toolName} requires approval`,
    policyId: 'platform:risk-table',
    riskLevel: 'high',
  });
}
