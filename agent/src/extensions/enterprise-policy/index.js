/**
 * enterprise-policy Extension (PR-06 B2).
 *
 * tool_call always registered (fail-closed). Passes stable Pi event.toolCallId
 * into policy evaluation, durable audit, and approval request.
 *
 * require_approval: creates durable PENDING approval + returns block.
 * Tool MUST NOT execute. Does not use in-process waiters.
 * Does not transition Run → WAITING_APPROVAL (resume is PR-09).
 */

import {
  makePolicyDecision,
  validatePolicyDecision,
} from './policy-decision.js';
import { createPolicyEngine } from './policy-engine.js';
import { DURABLE_APPROVAL_PENDING } from '../../domain/tool/approval-status.js';

export {
  validatePolicyDecision,
  makePolicyDecision,
  mergePolicyDecisions,
} from './policy-decision.js';
export { createPolicyEngine } from './policy-engine.js';
export { classifyTool, isLocalSandboxTool } from './tool-risk-classifier.js';
export { evaluateLocalArgGuards } from './arg-guards.js';

/**
 * @param {string} reasonCode
 * @param {string} reason
 * @param {object} [extra]
 */
function blockResult(reasonCode, reason, extra = {}) {
  return {
    block: true,
    reason: `${reasonCode}: ${reason}`,
    reasonCode,
    ...extra,
  };
}

/**
 * @param {{
 *   runContext: object,
 *   deps?: {
 *     policyEngine?: { evaluateToolCall?: Function } | null,
 *     policyLayers?: object,
 *     auditSink?: Function,
 *     approvalCoordinator?: { requestApproval?: Function } | null,
 *     rateLimitPort?: object | null,
 *     mcpReadOnlyTools?: Iterable<string>,
 *     mcpServerPolicies?: object,
 *     agentVersionToolPolicy?: object,
 *     governanceRecorder?: {
 *       recordPolicyDecision?: Function,
 *       requestApproval?: Function,
 *       enqueue?: Function,
 *     } | null,
 *     runSuspensionPort?: {
 *       onDurableApprovalPending?: (signal: object) => Promise<void> | void,
 *     } | null,
 *     onSessionStart?: Function,
 *   },
 * }} options
 */
export function createEnterprisePolicyExtension(options) {
  const runContext = options?.runContext;
  const deps = options?.deps ?? {};

  let engine = deps.policyEngine ?? null;
  if (
    !engine &&
    (deps.policyLayers ||
      deps.auditSink ||
      deps.agentVersionToolPolicy ||
      deps.governanceRecorder ||
      deps.mcpReadOnlyTools ||
      deps.mcpServerPolicies)
  ) {
    // Durable audit is owned by governanceRecorder when present; engine still
    // needs a successful auditSink for allow (in-memory no-op). Fail-closed if neither.
    const engineAudit =
      typeof deps.auditSink === 'function'
        ? deps.auditSink
        : deps.governanceRecorder
          ? async () => {}
          : undefined;
    engine = createPolicyEngine({
      layers: deps.policyLayers,
      auditSink: engineAudit,
      rateLimitPort: deps.rateLimitPort,
      mcpReadOnlyTools: deps.mcpReadOnlyTools,
      mcpServerPolicies: deps.mcpServerPolicies,
      agentVersionToolPolicy: deps.agentVersionToolPolicy,
    });
  }

  const governance = deps.governanceRecorder ?? null;
  const suspension = deps.runSuspensionPort ?? null;

  /**
   * @param {import('@earendil-works/pi-coding-agent').ExtensionAPI} pi
   */
  function enterprisePolicyExtension(pi) {
    pi.on('session_start', async (event, ctx) => {
      if (typeof deps.onSessionStart === 'function') {
        await deps.onSessionStart(event, ctx);
      }
      void runContext;
    });

    pi.on('tool_call', async (event, _ctx) => {
      const toolName = String(event?.toolName ?? event?.tool?.name ?? '');
      const args = event?.input ?? event?.args;
      // Stable Pi toolCallId — required for ledger/audit/approval correlation.
      const toolCallId = String(event?.toolCallId ?? '').trim();
      if (!toolCallId) {
        return blockResult(
          'TOOL_CALL_ID_REQUIRED',
          'Pi tool_call event missing toolCallId; refuse tool execution',
        );
      }

      if (!engine || typeof engine.evaluateToolCall !== 'function') {
        return blockResult(
          'POLICY_ENGINE_UNAVAILABLE',
          'policy engine is not injected; all tools denied',
        );
      }

      let raw;
      try {
        raw = await engine.evaluateToolCall({
          toolName,
          args,
          runContext,
          toolCallId,
        });
      } catch {
        return blockResult(
          'POLICY_ENGINE_UNAVAILABLE',
          'policy engine threw during evaluateToolCall',
        );
      }

      const decision = validatePolicyDecision(raw);
      if (!decision) {
        return blockResult(
          'POLICY_DECISION_INVALID',
          'policy engine returned incomplete PolicyDecision',
        );
      }

      // Durable policy audit + tool propose when governanceRecorder is injected.
      // Without governance: allow only if engine audit path was configured
      // (explicit policyEngine with auditSink, or deps.auditSink). Production
      // PiRunExecutor always injects governanceRecorder.
      const writeGovernance = async () => {
        if (!governance || typeof governance.recordPolicyDecision !== 'function') {
          const engineHasAudit =
            typeof deps.auditSink === 'function' || deps.policyEngine != null;
          if (
            (decision.decision === 'allow' ||
              decision.decision === 'require_approval') &&
            !engineHasAudit
          ) {
            throw Object.assign(
              new Error(
                'POLICY_AUDIT_UNAVAILABLE: governanceRecorder not injected and no auditSink/policyEngine',
              ),
              { code: 'POLICY_AUDIT_UNAVAILABLE' },
            );
          }
          return null;
        }
        // Call directly — promise-tail enqueue swallows errors into a latch,
        // and policy decisions must propagate DurablePolicyConflictError.
        return governance.recordPolicyDecision({
          toolCallId,
          toolName,
          args,
          decision,
        });
      };

      let govResult = null;
      try {
        govResult = await writeGovernance();
      } catch (err) {
        const code =
          /** @type {any} */ (err)?.code || 'POLICY_AUDIT_FAILED';
        // Durable prior state must keep blocking (including already-executed).
        const durableCodes = new Set([
          'POLICY_DURABLE_CONFLICT',
          'POLICY_DURABLE_PENDING',
          'POLICY_DURABLE_DENIED',
          'POLICY_DURABLE_ALREADY_EXECUTED',
          'POLICY_FINGERPRINT_MISMATCH',
          'POLICY_FINGERPRINT_MISSING',
          'POLICY_FINGERPRINT_REQUIRED',
          'CONFLICT',
        ]);
        if (
          durableCodes.has(String(code)) ||
          durableCodes.has(String(/** @type {any} */ (err)?.reasonCode || ''))
        ) {
          const reasonCode = String(
            /** @type {any} */ (err)?.reasonCode || code,
          );
          return blockResult(
            reasonCode,
            err instanceof Error ? err.message : 'durable policy conflict',
            {
              durablePending:
                /** @type {any} */ (err)?.toolExecution?.status ===
                'WAITING_APPROVAL'
                  ? {
                      kind: DURABLE_APPROVAL_PENDING,
                      toolCallId,
                      toolName,
                      runId: runContext?.runId,
                      status: 'PENDING',
                      toolExecutionId:
                        /** @type {any} */ (err)?.toolExecution
                          ?.toolExecutionId,
                    }
                  : null,
              runStatusHint: null,
            },
          );
        }
        if (
          decision.decision === 'allow' ||
          decision.decision === 'require_approval'
        ) {
          return blockResult(
            String(code),
            err instanceof Error ? err.message : 'durable policy audit failed',
          );
        }
        // deny still blocks even if audit path failed
        return blockResult(
          decision.reasonCode || 'POLICY_DENIED',
          decision.reason || 'policy denied',
        );
      }

      if (decision.decision === 'deny') {
        return blockResult(
          decision.reasonCode || 'POLICY_DENIED',
          decision.reason || 'policy denied',
        );
      }

      if (decision.decision === 'require_approval') {
        // Prefer durable governance requestApproval over in-process coordinator.
        if (
          governance &&
          typeof governance.requestApproval === 'function'
        ) {
          try {
            // Direct call so approval write failures surface (no enqueue latch).
            const pending = await governance.requestApproval({
              toolCallId,
              toolName,
              args,
              decision,
              toolExecutionId: govResult?.toolExecution?.toolExecutionId,
            });

            const signal = pending?.durablePending;
            if (
              suspension &&
              typeof suspension.onDurableApprovalPending === 'function' &&
              signal
            ) {
              try {
                await suspension.onDurableApprovalPending(signal);
              } catch {
                // Suspension port is best-effort metadata; still block tool.
              }
            }

            return blockResult(
              'POLICY_APPROVAL_REQUIRED',
              decision.reason || 'approval required',
              {
                durablePending: signal || {
                  kind: DURABLE_APPROVAL_PENDING,
                  toolCallId,
                  toolName,
                  runId: runContext?.runId,
                  status: 'PENDING',
                },
                // Explicit: B2 does not auto-transition Run to WAITING_APPROVAL.
                runStatusHint: null,
              },
            );
          } catch (err) {
            return blockResult(
              'POLICY_APPROVAL_UNAVAILABLE',
              err instanceof Error
                ? err.message
                : 'durable approval request failed',
            );
          }
        }

        // Injected coordinator only for tests; must not be process-local Map authority in prod.
        const coordinator = deps.approvalCoordinator;
        if (!coordinator || typeof coordinator.requestApproval !== 'function') {
          return blockResult(
            'POLICY_APPROVAL_UNAVAILABLE',
            'require_approval but no governanceRecorder/approvalCoordinator',
          );
        }
        let approval;
        try {
          approval = await coordinator.requestApproval({
            toolName,
            toolCallId,
            args,
            runContext,
            decision,
          });
        } catch {
          return blockResult(
            'POLICY_APPROVAL_UNAVAILABLE',
            'approval coordinator failed',
          );
        }
        const allowed =
          approval &&
          (approval.allowed === true || approval.status === 'approved');
        if (!allowed) {
          return blockResult(
            'POLICY_APPROVAL_REQUIRED',
            typeof approval?.reason === 'string' && approval.reason
              ? approval.reason
              : 'approval not granted',
            {
              durablePending: approval?.durablePending ?? null,
              runStatusHint: null,
            },
          );
        }
        return undefined;
      }

      if (decision.decision === 'allow') {
        return undefined;
      }

      return blockResult(
        'POLICY_DECISION_INVALID',
        'unrecognized policy decision',
      );
    });
  }

  enterprisePolicyExtension.extensionName = 'enterprise-policy';
  enterprisePolicyExtension.extensionMetadata = Object.freeze({
    name: 'enterprise-policy',
    role: 'policy-enforcement',
    slice: 'B2',
    failClosed: true,
    toolsRegistered: false,
    durableApprovalPending: true,
    // B2: does not transition Run to WAITING_APPROVAL; PR-09 resolves.
    claimsRunWaitingApproval: false,
  });
  return enterprisePolicyExtension;
}
