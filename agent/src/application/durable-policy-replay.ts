/**
 * durable 策略重放的兼容判定。
 *
 * 从 `fenced-tool-governance-recorder.ts` 拆出来：那个文件负责「把一次工具治理
 * 写进带围栏的事务」，而这里回答的是一个纯判定问题——「已经落库的这条
 * ToolExecution，和这次新评估出来的决定兼容吗」。它没有仓储、事务或围栏依赖，
 * 和已经住在仓储模块里的 `assertToolExecutionReplayMatch` 是同一类东西。
 */

import { TOOL_EXECUTION_STATUS } from '../domain/tool/tool-execution-status.js';

/** 过渡期宽松类型：注入的依赖多数还是 JS 类，形状由各自的模块负责。 */
type Loose = any;

/**
 * Durable policy state conflict — enterprise-policy maps to block.
 * Does not claim PR-09 resume; prevents allow bypass of prior deny/pending.
 */
export class DurablePolicyConflictError extends Error {
  // TS 要求类字段显式声明（JS 里它们只在构造器里赋值）。
  name: string;
  code: string;
  reasonCode: Loose;
  toolExecution: Loose;

  constructor(message: string, meta: { reasonCode?: string, toolExecution?: Record<string, any> } = {}) {
    super(message);
    this.name = 'DurablePolicyConflictError';
    this.code = 'POLICY_DURABLE_CONFLICT';
    this.reasonCode = meta.reasonCode || 'POLICY_DURABLE_CONFLICT';
    this.toolExecution = meta.toolExecution ?? null;
  }
}

/**
 * Enforce durable prior policy state vs a freshly evaluated decision.
 *
 * Exact policy fingerprint required (no broad POLICY/DENIED matching).
 * Fresh `allow` may proceed while PROPOSED. RUNNING is replay-compatible only
 * before a Sandbox request claim exists; claimed/terminal states cannot re-enter.
 *
 * @param toolExecution
 * @param {{
 *   decision: string,
 *   desiredStatus: string,
 *   errorCode?: string | null,
 *   policyFingerprint: string,
 * }} next
 */
export function assertCompatiblePolicyReplay(toolExecution: Record<string, any>, next: { decision: string, desiredStatus: string, errorCode?: string | null, policyFingerprint: string, }) {
  const status = toolExecution.status;
  const decision = next.decision;
  const nextPf = next.policyFingerprint
    ? String(next.policyFingerprint).toLowerCase()
    : '';
  const havePf = toolExecution._policyFingerprint
    ? String(toolExecution._policyFingerprint).toLowerCase()
    : '';

  if (!nextPf || !/^[0-9a-f]{64}$/.test(nextPf)) {
    throw new DurablePolicyConflictError(
      'POLICY_FINGERPRINT_REQUIRED: policy replay requires exact decision fingerprint',
      { reasonCode: 'POLICY_FINGERPRINT_REQUIRED', toolExecution },
    );
  }
  // Legacy rows without stored fingerprint: fail closed for policy path.
  if (!havePf) {
    throw new DurablePolicyConflictError(
      'POLICY_FINGERPRINT_MISSING: durable ToolExecution has no policy fingerprint',
      { reasonCode: 'POLICY_FINGERPRINT_MISSING', toolExecution },
    );
  }
  if (havePf !== nextPf) {
    throw new DurablePolicyConflictError(
      'POLICY_FINGERPRINT_MISMATCH: changed decision/reasonCode/reason/policyId/riskLevel',
      { reasonCode: 'POLICY_FINGERPRINT_MISMATCH', toolExecution },
    );
  }

  // Fingerprints match — status-specific compatibility for tool_call gate.
  if (decision === 'allow') {
    // Exact-policy PROPOSED, or the brief pre-claim RUNNING window, is safe to
    // replay. The toolCall id remains unique and transport binding is atomic.
    if (status === TOOL_EXECUTION_STATUS.PROPOSED) {
      return;
    }
    if (
      status === TOOL_EXECUTION_STATUS.RUNNING &&
      !toolExecution.requestHash
    ) {
      return;
    }
    if (
      status === TOOL_EXECUTION_STATUS.RUNNING ||
      status === TOOL_EXECUTION_STATUS.SUCCEEDED
    ) {
      throw new DurablePolicyConflictError(
        `durable ToolExecution is ${status}; refuse re-execution (no transport idempotency yet)`,
        {
          reasonCode: 'POLICY_DURABLE_ALREADY_EXECUTED',
          toolExecution,
        },
      );
    }
    if (status === TOOL_EXECUTION_STATUS.FAILED) {
      throw new DurablePolicyConflictError(
        'durable ToolExecution is FAILED; refuse re-execution under allow',
        { reasonCode: 'POLICY_DURABLE_ALREADY_EXECUTED', toolExecution },
      );
    }
    if (status === TOOL_EXECUTION_STATUS.WAITING_APPROVAL) {
      throw new DurablePolicyConflictError(
        'durable ToolExecution is WAITING_APPROVAL; fresh allow cannot bypass',
        { reasonCode: 'POLICY_DURABLE_PENDING', toolExecution },
      );
    }
    throw new DurablePolicyConflictError(
      `durable ToolExecution is ${status}; refuse allow replay`,
      { reasonCode: 'POLICY_DURABLE_CONFLICT', toolExecution },
    );
  }

  if (decision === 'deny') {
    // Exact same deny on FAILED: idempotent block (no new audit).
    if (status === TOOL_EXECUTION_STATUS.FAILED) {
      return;
    }
    // PROPOSED may still transition to FAILED (same fingerprint) — rare.
    if (status === TOOL_EXECUTION_STATUS.PROPOSED) {
      return;
    }
    throw new DurablePolicyConflictError(
      `durable ToolExecution is ${status}; conflicting deny replay`,
      { reasonCode: 'POLICY_DURABLE_CONFLICT', toolExecution },
    );
  }

  if (decision === 'require_approval') {
    if (status === TOOL_EXECUTION_STATUS.WAITING_APPROVAL) {
      return;
    }
    if (status === TOOL_EXECUTION_STATUS.PROPOSED) {
      return;
    }
    throw new DurablePolicyConflictError(
      `durable ToolExecution is ${status}; conflicting require_approval replay`,
      { reasonCode: 'POLICY_DURABLE_CONFLICT', toolExecution },
    );
  }

  throw new DurablePolicyConflictError(
    `unrecognized policy decision for durable replay: ${decision}`,
    { reasonCode: 'POLICY_DURABLE_CONFLICT', toolExecution },
  );
}
