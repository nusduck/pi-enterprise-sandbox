/**
 * Sandbox tool definitions for pi-coding-agent.
 * Each tool defers execution to a request-scoped sandbox client.
 *
 * Tools: read, write, edit, apply_patch, bash, submit_artifact, ls, find, grep,
 *        process_start/status/logs/wait/write_stdin/signal/cancel
 *
 * Prefer createSandboxTools({ client, sessionId|getSessionId, approvalNotifier })
 * so concurrent chat turns never share session/approval state.
 *
 * Security:
 * - preExecuteGate + ensureApproved (fail-closed for write tools)
 * - workspace write mutex for serial side-effect tools
 * - APPROVAL_MODE controls approval_required (ask / auto_approve / deny);
 *   hard_deny is never overridden
 * - Tool Execution Ledger (ADR §4.4): prepare → executing → terminal
 *   with idempotency so lost HTTP responses do not double side-effects
 *
 * NOTE: createAgentSession({ tools: [...] }) is an allowlist — every tool
 * name here must also appear in that list or the model will not see it.
 */
import { Type } from 'typebox';
import { createHash, randomUUID } from 'node:crypto';
import * as defaultSb from '../../../../infrastructure/sandbox-client.js';
import { config } from '../../../../config.js';
import {
  POLICY_VERSION,
  APPROVAL_MODE,
  classifyToolSideEffect,
  normalizeApprovalMode,
  preExecuteGate,
  workspaceWriteMutex,
  emitToolAudit,
  buildToolAuditEvent,
} from '../policy/index.js';
import {
  isUnderSkillRoot,
  commandTouchesSkillRoot,
  isReadonlySkillExecution,
  DEFAULT_SKILL_ROOTS,
} from '../../../../skills/paths.js';
import { ApprovalSuspendedError } from '../../../../services/approval-waiter.js';
import { normalizeWorkspaceToolParams } from '../../../../workspace-paths.js';
import { summarizeToolArguments } from '../../../../runtime/tool-payload-sanitizer.js';

/** Terminal ledger statuses that must never re-execute side effects. */
const LEDGER_TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'unknown']);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function stableSerialize(value) {
  return JSON.stringify(canonicalize(value));
}

/**
 * @typedef {object} SandboxToolsContext
 * @property {ReturnType<typeof defaultSb.createSandboxClient> | typeof defaultSb} [client]
 * @property {string | null} [sessionId]
 * @property {() => string | null | undefined} [getSessionId]
 * @property {() => string | null | undefined} [getWorkspaceKey]
 * @property {((ev: object) => void) | null} [approvalNotifier]
 * @property {boolean} [approvalEnabled]
 * @property {'ask'|'auto_approve'|'deny'} [approvalMode]
 * @property {() => object} [getMeta]
 * @property {((ev: object) => void) | null} [auditSink]
 * @property {(pending: object) => Promise<void> | void} [onApprovalSuspend]
 * @property {() => object|null|undefined} [getPreApprovedAttempt]
 * @property {() => object|null|undefined} [claimPreApprovedAttempt]
 * @property {(attempt: object) => void} [releasePreApprovedAttempt]
 * @property {() => void} [consumePreApprovedAttempt]
 */

/**
 * Build sandbox tools closed over one chat-turn context.
 * @param {SandboxToolsContext} [ctx]
 */
export function createSandboxTools(ctx = {}) {
  const sb = ctx.client || defaultSb;
  const getSessionId =
    typeof ctx.getSessionId === 'function'
      ? ctx.getSessionId
      : () => ctx.sessionId ?? null;
  const getWorkspaceKey =
    typeof ctx.getWorkspaceKey === 'function'
      ? ctx.getWorkspaceKey
      : () => getSessionId() || 'default';
  const approvalNotifier =
    typeof ctx.approvalNotifier === 'function' ? ctx.approvalNotifier : null;
  const approvalMode = normalizeApprovalMode(
    ctx.approvalMode ??
      (ctx.approvalEnabled == null
        ? config.APPROVAL_MODE || APPROVAL_MODE.ASK
        : ctx.approvalEnabled),
  );
  const getMeta = typeof ctx.getMeta === 'function' ? ctx.getMeta : () => ({});
  const auditSink = typeof ctx.auditSink === 'function' ? ctx.auditSink : null;
  const skillRoots = ctx.skillRoots || config.SKILL_ROOTS || DEFAULT_SKILL_ROOTS;
  const onApprovalSuspend =
    typeof ctx.onApprovalSuspend === 'function' ? ctx.onApprovalSuspend : null;
  const getPreApprovedAttempt =
    typeof ctx.getPreApprovedAttempt === 'function' ? ctx.getPreApprovedAttempt : () => null;
  const claimPreApprovedAttempt =
    typeof ctx.claimPreApprovedAttempt === 'function'
      ? ctx.claimPreApprovedAttempt
      : () => getPreApprovedAttempt();
  const releasePreApprovedAttempt =
    typeof ctx.releasePreApprovedAttempt === 'function'
      ? ctx.releasePreApprovedAttempt
      : () => {};
  const consumePreApprovedAttempt =
    typeof ctx.consumePreApprovedAttempt === 'function' ? ctx.consumePreApprovedAttempt : () => {};

  function metaNow() {
    return {
      session_id: getSessionId(),
      workspace_key: getWorkspaceKey(),
      policy_version: POLICY_VERSION,
      ...getMeta(),
    };
  }

  /**
   * Block generic tools from writing / shelling into the shared skill tree.
   * Skill mutations must go through skill_install / skill_edit (development).
   * @param {string} toolName
   * @param {object} params
   * @returns {{ blocked: true, reason: string } | { blocked: false }}
   */
  function skillRootGuard(toolName, params = {}) {
    if (params.path && isUnderSkillRoot(params.path, skillRoots)) {
      return {
        blocked: true,
        reason:
          'skill root is not writable via generic tools; use skill_install/skill_edit (SKILLS_MODE=development)',
      };
    }
    if (
      toolName === 'bash' &&
      params.command &&
      commandTouchesSkillRoot(params.command, skillRoots) &&
      !isReadonlySkillExecution(params.command, skillRoots)
    ) {
      return {
        blocked: true,
        reason:
          'bash must not target skill root; use skill_install/skill_edit (SKILLS_MODE=development)',
      };
    }
    return { blocked: false };
  }

  /**
   * Run policy check. When pending_approval, park the run via checkpoint +
   * ApprovalSuspendedError (no fixed-time in-tool polling — ADR §4.8).
   * Fail-closed for all write-class tools when the check endpoint errors.
   * When APPROVAL_MODE=deny, approval-required tools are rejected
   * deterministically. Only explicit auto_approve bypasses the gate.
   *
   * @param {string} toolName
   * @param {object} [params]
   * @param {string|null} [toolCallId]
   * @returns {Promise<{ ok: boolean, reason?: string, approval_id?: string, policy_version?: string, approval_bypassed?: boolean }>}
   */
  async function ensureApproved(
    toolName,
    params = {},
    toolCallId = null,
    idempotencyKey = null,
  ) {
    const sessionId = getSessionId();
    if (!sessionId) {
      // No session: fail-closed for write tools (cannot re-check Sandbox)
      const side = classifyToolSideEffect(toolName);
      if (side === 'write') {
        return { ok: false, reason: 'No sandbox session for policy check (fail-closed)' };
      }
      return { ok: true };
    }

    // Local three-tier gate first (hard_deny short-circuit + audit)
    const local = preExecuteGate({
      toolName,
      params,
      approvalMode,
      meta: metaNow(),
      auditSink,
    });
    if (!local.ok) {
      return {
        ok: false,
        reason: local.reason,
        policy_version: local.policy?.policy_version || POLICY_VERSION,
      };
    }

    const meta = metaNow();
    const operationFingerprint = makeApprovalOperationFingerprint(toolName, params);
    const preApprovedAttempt = getPreApprovedAttempt();
    const matchesPreApprovedAttempt =
      approvalMode === APPROVAL_MODE.ASK &&
      preApprovedAttempt?.idempotency_key &&
      preApprovedAttempt?.operation_fingerprint === operationFingerprint &&
      preApprovedAttempt?.tool_name === toolName &&
      (!preApprovedAttempt.sandbox_session_id ||
        preApprovedAttempt.sandbox_session_id === sessionId) &&
      (!preApprovedAttempt.run_id || preApprovedAttempt.run_id === (meta.run_id || null));
    const claimedPreApprovedAttempt = matchesPreApprovedAttempt
      ? claimPreApprovedAttempt()
      : null;
    if (matchesPreApprovedAttempt && claimedPreApprovedAttempt !== preApprovedAttempt) {
      return {
        ok: false,
        reason: 'Approval resume authorization is already in use',
        policy_version: POLICY_VERSION,
      };
    }
    const canUsePreApprovedAttempt = Boolean(
      preApprovedAttempt && claimedPreApprovedAttempt === preApprovedAttempt,
    );
    const approvalKey = canUsePreApprovedAttempt
      ? claimedPreApprovedAttempt.idempotency_key
      : idempotencyKey;

    // Remote Sandbox re-check is authoritative (dual enforcement). Always call for
    // write-class tools so approval UX / bypass audit stay consistent even when
    // the local catalog would auto-allow.
    let check;
    try {
      check = await sb.approvalCheck(sessionId, {
        tool_name: toolName,
        command: params.command || null,
        path: params.path || null,
        timeout: params.timeout || null,
        idempotency_key: approvalKey,
      });
    } catch (err) {
      // Fail-closed for write-class tools (includes bash, write, edit, submit_artifact, unknown)
      const side = classifyToolSideEffect(toolName);
      if (claimedPreApprovedAttempt) releasePreApprovedAttempt(claimedPreApprovedAttempt);
      if (side === 'write') {
        return {
          ok: false,
          reason: `Approval check failed: ${err.message}`,
          policy_version: POLICY_VERSION,
        };
      }
      return { ok: true, policy_version: POLICY_VERSION };
    }

    if (check.status === 'approved') {
      if (canUsePreApprovedAttempt) consumePreApprovedAttempt();
      return {
        ok: true,
        policy_version: check.policy_version || POLICY_VERSION,
        approval_bypassed: Boolean(check.approval_bypassed),
      };
    }
    if (check.status === 'rejected') {
      if (canUsePreApprovedAttempt) consumePreApprovedAttempt();
      return {
        ok: false,
        reason: check.reason || 'Rejected by policy',
        policy_version: check.policy_version || POLICY_VERSION,
      };
    }
    if (check.status !== 'pending_approval' || !check.approval_id) {
      if (canUsePreApprovedAttempt) releasePreApprovedAttempt(claimedPreApprovedAttempt);
      return {
        ok: false,
        reason: check.reason || 'Not allowed',
        policy_version: check.policy_version || POLICY_VERSION,
      };
    }

    const approvalId = check.approval_id;
    // A resume token is only valid for the exact normalized operation and one
    // successful approval-check response. A changed operation gets its own
    // approval scope instead of inheriting the prior decision.
    const pending = {
      approval_id: approvalId,
      tool_name: toolName,
      tool_call_id: toolCallId || null,
      params: params || {},
      run_id: meta.run_id || null,
      conversation_id: meta.conversation_id || null,
      sandbox_session_id: sessionId,
      reason: check.reason,
      risk_level: check.risk_level,
      policy_version: check.policy_version || POLICY_VERSION,
      idempotency_key: approvalKey,
      operation_fingerprint: operationFingerprint,
    };
    if (canUsePreApprovedAttempt) releasePreApprovedAttempt(claimedPreApprovedAttempt);

    if (approvalNotifier) {
      approvalNotifier({
        type: 'approval_required',
        approval_id: approvalId,
        tool_name: toolName,
        command: params.command,
        path: params.path,
        reason: check.reason,
        risk_level: check.risk_level,
        policy_version: check.policy_version || POLICY_VERSION,
        idempotency_key: approvalKey,
        operation_fingerprint: operationFingerprint,
      });
    }

    // B6: checkpoint + release path — no fixed-time poll inside the tool.
    if (onApprovalSuspend) {
      await onApprovalSuspend(pending);
    }
    throw new ApprovalSuspendedError(pending);
  }

  /**
   * Build a stable Tool Ledger idempotency key for a tool call.
   * Prefer an SDK toolCallId; fall back to a hash of name+args so retries collide.
   * @param {string} toolName
   * @param {string|null} toolCallId
   * @param {object} params
   */
  function makeIdempotencyKey(toolName, toolCallId, params) {
    if (toolCallId) return `tc_${toolCallId}`;
    const meta = metaNow();
    const basis = stableSerialize({
      tool: toolName,
      run_id: meta.run_id || null,
      params: params || {},
    });
    const h = createHash('sha256').update(basis).digest('hex').slice(0, 24);
    return `idem_${toolName}_${h}`;
  }

  /**
   * Fingerprint the normalized operation separately from the attempt key so
   * a resume with a new SDK call ID can validate an exact one-shot match.
   */
  function makeApprovalOperationFingerprint(toolName, params) {
    return createHash('sha256')
      .update(stableSerialize({ tool_name: toolName, params: params || {} }))
      .digest('hex');
  }

  /**
   * Approval scope is per execution attempt. The SDK tool call identity keeps
   * a retry of one attempt idempotent while allowing a later identical tool
   * invocation to receive a fresh approval. Resume with a changed SDK ID uses
   * the one-shot key carried in the pending approval above.
   */
  function makeApprovalIdempotencyKey(toolName, toolCallId, params) {
    const meta = metaNow();
    const basis = stableSerialize({
      session_id: meta.session_id || getSessionId() || null,
      run_id: meta.run_id || null,
      tool_name: toolName,
      tool_call_id: toolCallId || null,
      params: params || {},
    });
    const h = createHash('sha256').update(basis).digest('hex').slice(0, 32);
    return `approval_${h}`;
  }

  /**
   * Replay a previously stored tool result from the ledger (idempotent retry).
   * @param {object} ledgerRow
   */
  function replayFromLedger(ledgerRow) {
    const cached = ledgerRow?.result_json;
    if (cached && typeof cached === 'object' && Array.isArray(cached.content)) {
      return {
        content: cached.content,
        details: {
          ...(cached.details || {}),
          ledger_replay: true,
          tool_call_id: ledgerRow.tool_call_id,
          status: ledgerRow.status,
        },
        isError: Boolean(cached.isError || ledgerRow.status === 'failed'),
      };
    }
    const summary =
      ledgerRow?.result_summary ||
      ledgerRow?.summary ||
      ledgerRow?.error ||
      `Tool already ${ledgerRow?.status || 'terminal'} (idempotent replay)`;
    const isErr = ledgerRow?.status === 'failed' || ledgerRow?.status === 'cancelled';
    return {
      content: [{ type: 'text', text: summary }],
      details: {
        ledger_replay: true,
        tool_call_id: ledgerRow?.tool_call_id,
        status: ledgerRow?.status,
        isError: isErr,
      },
      isError: isErr,
    };
  }

  /**
   * Best-effort ledger lifecycle around a tool body.
   * Fail-open on ledger HTTP errors so sandbox tools still work offline,
   * but when a terminal row is observed, never re-run side effects.
   *
   * Status flow: prepared → (waiting_approval) → executing → terminal
   *
   * @param {string} toolName
   * @param {string|null} toolCallId
   * @param {object} params
   * @param {(ctx: { callId: string, idempotencyKey: string, approvalIdempotencyKey: string, markWaitingApproval: () => Promise<void>, markExecuting: () => Promise<void> }) => Promise<object>} bodyFn
   */
  async function withLedger(toolName, toolCallId, params, bodyFn) {
    const meta = metaNow();
    const callId = toolCallId || `tc_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const idempotencyKey = makeIdempotencyKey(toolName, toolCallId, params);
    const approvalIdempotencyKey = makeApprovalIdempotencyKey(toolName, callId, params);
    const ledgerParams = summarizeToolArguments(toolName, params);
    const runId = meta.run_id || 'run_unknown';
    let ledgerActive = false;

    // 1) Prepare (idempotent)
    try {
      if (typeof sb.prepareToolExecution === 'function') {
        const prepared = await sb.prepareToolExecution({
          tool_call_id: callId,
          run_id: runId,
          idempotency_key: idempotencyKey,
          tool_name: toolName,
          arguments: ledgerParams,
          session_id: meta.session_id || getSessionId() || null,
          conversation_id: meta.conversation_id || null,
          workspace_id: meta.workspace_id || meta.workspace_key || null,
          summary: `${toolName}`,
        });
        ledgerActive = true;
        if (prepared && LEDGER_TERMINAL.has(prepared.status)) {
          return replayFromLedger(prepared);
        }
        // executing already: do not double side-effects
        if (prepared?.status === 'executing') {
          return {
            content: [
              {
                type: 'text',
                text:
                  `Tool call ${callId} is already executing; ` +
                  'refusing duplicate side-effect (query ledger for final status)',
              },
            ],
            details: {
              isError: true,
              tool_call_id: callId,
              status: 'executing',
              idempotent_block: true,
            },
            isError: true,
          };
        }
      }
    } catch {
      ledgerActive = false;
    }

    const markWaitingApproval = async () => {
      if (ledgerActive && typeof sb.markToolWaitingApproval === 'function') {
        try {
          await sb.markToolWaitingApproval(callId);
        } catch {
          /* best-effort */
        }
      }
    };

    const markExecuting = async () => {
      if (ledgerActive && typeof sb.markToolExecuting === 'function') {
        try {
          await sb.markToolExecuting(callId);
        } catch {
          /* best-effort */
        }
      }
    };

    // 2) Body (approval may mark waiting_approval; then executing; then side effect)
    let result;
    let thrown = null;
    try {
      result = await bodyFn({
        callId,
        idempotencyKey,
        approvalIdempotencyKey,
        markWaitingApproval,
        markExecuting,
      });
    } catch (err) {
      // Do not terminalize suspended approvals — resume will complete the ledger.
      if (err instanceof ApprovalSuspendedError || err?.name === 'ApprovalSuspendedError') {
        await markWaitingApproval();
        throw err;
      }
      thrown = err;
      result = {
        content: [{ type: 'text', text: `Error: ${err.message}` }],
        details: { isError: true },
        isError: true,
      };
    }

    // 3) Terminal
    if (ledgerActive && typeof sb.markToolTerminal === 'function') {
      const isErr = Boolean(result?.isError || thrown);
      const textParts = Array.isArray(result?.content)
        ? result.content
            .filter((c) => c && c.type === 'text' && c.text)
            .map((c) => c.text)
            .join('\n')
        : '';
      const summary = (textParts || (thrown ? thrown.message : `${toolName} done`)).slice(
        0,
        2000,
      );
      try {
        await sb.markToolTerminal(callId, {
          status: isErr ? 'failed' : 'succeeded',
          summary,
          error: isErr ? summary : null,
          result_json: {
            content: result?.content || [],
            details: result?.details || {},
            isError: isErr,
          },
        });
      } catch {
        try {
          await sb.markToolTerminal(callId, {
            status: 'unknown',
            summary: 'terminal mark failed after execution',
            error: 'ledger terminal update failed',
          });
        } catch {
          /* ignore */
        }
      }
    }

    if (result && typeof result === 'object') {
      result.details = {
        ...(result.details || {}),
        tool_call_id: callId,
      };
    }
    return result;
  }

  /**
   * Wrap execute with ledger + write mutex + approval gate for write-class tools.
   * @param {string} toolName
   * @param {Function} executeFn
   */
  function wrapExecute(toolName, executeFn) {
    return async (toolCallId, params, ...rest) => {
      let normalizedParams;
      try {
        normalizedParams = normalizeWorkspaceToolParams(toolName, params, {
          logicalRoot: config.SESSION_WORKSPACE_CWD,
          isSkillPath: (value) => isUnderSkillRoot(value, skillRoots),
        });
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          details: { isError: true },
          isError: true,
        };
      }
      const side = classifyToolSideEffect(toolName);
      const run = async () =>
        withLedger(toolName, toolCallId, normalizedParams, async (ctx) => {
          if (side === 'write') {
            // Mark waiting before policy gate (resume keeps ledger at waiting_approval)
            await ctx.markWaitingApproval();
            const gate = await ensureApproved(
              toolName,
              normalizedParams,
              ctx.callId,
              ctx.approvalIdempotencyKey,
            );
            if (!gate.ok) {
              return {
                content: [
                  { type: 'text', text: `Blocked (policy): ${gate.reason}` },
                ],
                details: {
                  isError: true,
                  approval_id: gate.approval_id,
                  policy_version: gate.policy_version || POLICY_VERSION,
                  tool_call_id: ctx.callId,
                },
                isError: true,
              };
            }
          }
          await ctx.markExecuting();
          return executeFn(ctx.callId, normalizedParams, ...rest);
        });

      if (side === 'write') {
        const key = getWorkspaceKey() || getSessionId() || 'default';
        return workspaceWriteMutex.runExclusive(key, run);
      }
      return run();
    };
  }

  // ── Tool: read ──────────────────────────────────

  const readTool = {
    name: 'read',
    label: 'Read File',
    description:
      'Read a workspace or persistent /tmp file (relative or logical path) OR load a Skill package. ' +
      'For skills listed in <available_skills>, pass the absolute <location> ' +
      'path (e.g. /home/sandbox/skill/docx/SKILL.md) — required before specialized document work.',
    parameters: Type.Object({
      path: Type.String({
        description:
          'Workspace-relative path, logical /home/sandbox/workspace/... path, persistent /tmp/... path, or absolute skill path under /home/sandbox/skill/.../SKILL.md',
      }),
      offset: Type.Optional(Type.Number({ description: 'Start line (1-indexed)' })),
      limit: Type.Optional(Type.Number({ description: 'Max lines' })),
    }),
    execute: wrapExecute('read', async (_toolCallId, params) => {
      // Skill files: read from Agent local FS (mounted skills), not sandbox workspace
      const p = String(params.path || '');
      if (
        p.startsWith('/home/sandbox/skill/') ||
        p.startsWith('/sandbox/skills/') ||
        p.startsWith('/app/.pi/skills/') ||
        p.startsWith('.pi/skills/') ||
        // bare skill package name → default SKILL.md
        (!p.includes('/') && !p.includes('\\') && p.length > 0 && p !== '.' && p !== '..')
      ) {
        const skillPath =
          !p.includes('/') && !p.includes('\\')
            ? `/home/sandbox/skill/${p}/SKILL.md`
            : p;
        if (
          skillPath.startsWith('/home/sandbox/skill/') ||
          skillPath.startsWith('/sandbox/skills/') ||
          skillPath.startsWith('/app/.pi/skills/') ||
          skillPath.startsWith('.pi/skills/')
        ) {
          return readLocalSkill(skillPath);
        }
      }
      try {
        const sessionId = getSessionId();
        const data =
          params.offset != null || params.limit != null
            ? await sb.readFileWithRange(sessionId, params.path, params.offset, params.limit)
            : await sb.readFile(sessionId, params.path);
        return {
          content: [{ type: 'text', text: data.content || '' }],
          details: { size: data.size, truncated: data.truncated },
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          details: { isError: true },
        };
      }
    }),
  };

  // ── Tool: write ─────────────────────────────────

  const writeTool = {
    name: 'write',
    label: 'Write File',
    description:
      'Write content to a private file in the sandbox workspace or persistent conversation /tmp. ' +
      'Does NOT share the file with the user or create a download link. ' +
      'To deliver a file to the user, call submit_artifact after writing.',
    parameters: Type.Object({
      path: Type.String({ description: 'Workspace-relative, logical workspace, or /tmp path' }),
      content: Type.String({ description: 'Content to write' }),
    }),
    execute: wrapExecute('write', async (_toolCallId, params) => {
      const guard = skillRootGuard('write', params);
      if (guard.blocked) {
        return {
          content: [{ type: 'text', text: `Blocked (policy): ${guard.reason}` }],
          details: { isError: true, policy_version: POLICY_VERSION },
          isError: true,
        };
      }
      try {
        const data = await sb.writeFile(getSessionId(), params.path, params.content);
        return {
          content: [{ type: 'text', text: `Written ${data.size} bytes to ${params.path}` }],
          details: { size: data.size, path: params.path },
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          details: { isError: true },
        };
      }
    }),
  };

  // ── Tool: edit — unique replace via sandbox (ADR §9) ──

  const editTool = {
    name: 'edit',
    label: 'Edit File',
    description:
      'Replace a unique old_string with new_string in a private workspace file. ' +
      'Fails if old_string is missing or matches multiple times (returns match count + line numbers). ' +
      'Returns unified diff and before/after SHA-256 hashes. ' +
      'Does NOT share the file with the user. Call submit_artifact to deliver a file.',
    parameters: Type.Object({
      path: Type.String({ description: 'Workspace-relative, logical workspace, or /tmp path' }),
      old_string: Type.String({ description: 'Exact text to find (must match once)' }),
      new_string: Type.String({ description: 'Replacement text' }),
      expected_hash: Type.Optional(
        Type.String({ description: 'Optional SHA-256 of current content (race check)' }),
      ),
    }),
    execute: wrapExecute('edit', async (_toolCallId, params) => {
      const guard = skillRootGuard('edit', params);
      if (guard.blocked) {
        return {
          content: [{ type: 'text', text: `Blocked (policy): ${guard.reason}` }],
          details: { isError: true, policy_version: POLICY_VERSION },
          isError: true,
        };
      }
      try {
        const sessionId = getSessionId();
        const data = await sb.editFile(sessionId, {
          path: params.path,
          old_string: params.old_string,
          new_string: params.new_string,
          expected_hash: params.expected_hash || null,
        });
        if (!data.ok) {
          const multi =
            data.match_count != null && data.match_count > 1
              ? `\nmatch_count=${data.match_count} lines=[${(data.match_lines || []).join(', ')}]`
              : '';
          return {
            content: [
              {
                type: 'text',
                text: `Error: ${data.error || 'edit failed'}${multi}`,
              },
            ],
            details: {
              isError: true,
              path: data.path || params.path,
              match_count: data.match_count,
              match_lines: data.match_lines,
              before_hash: data.before_hash,
            },
            isError: true,
          };
        }
        const header =
          `Edited ${data.path}\n` +
          `before_hash=${data.before_hash}\n` +
          `after_hash=${data.after_hash}\n` +
          `changed_lines=${data.changed_lines}`;
        return {
          content: [
            {
              type: 'text',
              text: data.diff ? `${header}\n\n${data.diff}` : header,
            },
          ],
          details: {
            path: data.path,
            before_hash: data.before_hash,
            after_hash: data.after_hash,
            diff: data.diff,
            changed_lines: data.changed_lines,
          },
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          details: { isError: true },
          isError: true,
        };
      }
    }),
  };

  // ── Tool: apply_patch ───────────────────────────

  const applyPatchTool = {
    name: 'apply_patch',
    label: 'Apply Patch',
    description:
      'Apply a unified diff patch to a single private workspace file. ' +
      'Returns unified diff of the applied change plus before/after SHA-256 hashes. ' +
      'Does NOT share the file with the user. Call submit_artifact to deliver a file.',
    parameters: Type.Object({
      path: Type.String({ description: 'Workspace-relative, logical workspace, or /tmp path' }),
      patch: Type.String({ description: 'Unified diff (---/+++/@@ hunks)' }),
      expected_hash: Type.Optional(
        Type.String({ description: 'Optional SHA-256 of current content (race check)' }),
      ),
    }),
    execute: wrapExecute('apply_patch', async (_toolCallId, params) => {
      const guard = skillRootGuard('apply_patch', params);
      if (guard.blocked) {
        return {
          content: [{ type: 'text', text: `Blocked (policy): ${guard.reason}` }],
          details: { isError: true, policy_version: POLICY_VERSION },
          isError: true,
        };
      }
      try {
        const sessionId = getSessionId();
        const data = await sb.applyPatch(sessionId, {
          path: params.path,
          patch: params.patch,
          expected_hash: params.expected_hash || null,
        });
        if (!data.ok) {
          return {
            content: [
              { type: 'text', text: `Error: ${data.error || 'apply_patch failed'}` },
            ],
            details: {
              isError: true,
              path: data.path || params.path,
              before_hash: data.before_hash,
            },
            isError: true,
          };
        }
        const header =
          `Patched ${data.path}\n` +
          `before_hash=${data.before_hash}\n` +
          `after_hash=${data.after_hash}\n` +
          `changed_lines=${data.changed_lines}`;
        return {
          content: [
            {
              type: 'text',
              text: data.diff ? `${header}\n\n${data.diff}` : header,
            },
          ],
          details: {
            path: data.path,
            before_hash: data.before_hash,
            after_hash: data.after_hash,
            diff: data.diff,
            changed_lines: data.changed_lines,
          },
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          details: { isError: true },
          isError: true,
        };
      }
    }),
  };

  // ── Tool: bash ──────────────────────────────────

  const bashTool = {
    name: 'bash',
    label: 'Run Command',
    description:
      'Run a shell command in the sandbox (Python, bash, node). ' +
      'Destructive or network-related commands may pause for human approval.',
    parameters: Type.Object({
      command: Type.String({ description: 'Shell command' }),
      timeout: Type.Optional(Type.Number({ description: 'Seconds (max 300)' })),
    }),
    execute: wrapExecute('bash', async (_toolCallId, params) => {
      const guard = skillRootGuard('bash', params);
      if (guard.blocked) {
        return {
          content: [{ type: 'text', text: `Blocked (policy): ${guard.reason}` }],
          details: { isError: true, policy_version: POLICY_VERSION },
          isError: true,
        };
      }
      try {
        const r = await sb.executeCommand(getSessionId(), params.command, params.timeout || 120);
        const isErr = r.exit_code != null && r.exit_code !== 0;
        const out = [
          r.stdout_preview ? `STDOUT:\n${r.stdout_preview}` : '',
          r.stderr_preview ? `STDERR:\n${r.stderr_preview}` : '',
        ]
          .filter(Boolean)
          .join('\n\n') || '(no output)';
        return {
          content: [{ type: 'text', text: out }],
          details: { exit_code: r.exit_code, duration_ms: r.duration_ms },
          isError: isErr,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          details: { isError: true },
        };
      }
    }),
  };

  // ── Tool: submit_artifact ───────────────────────

  const submitArtifactTool = {
    name: 'submit_artifact',
    label: 'Submit Artifact',
    description:
      'Submit a workspace file as a user deliverable (downloadable artifact). ' +
      'This is the ONLY way to share files with the user — write/edit/bash do not create download links. ' +
      'Call only for final, important, or user-requested files. ' +
      'There is no automatic workspace scan; intermediate work stays private until submitted.',
    parameters: Type.Object({
      path: Type.String({ description: 'Workspace-relative, logical workspace, or /tmp path' }),
      name: Type.Optional(Type.String({ description: 'Display name (defaults to filename)' })),
      mime_type: Type.Optional(
        Type.String({ description: 'MIME type (default: application/octet-stream)' }),
      ),
    }),
    execute: wrapExecute('submit_artifact', async (_toolCallId, params) => {
      try {
        const name = params.name || params.path.split('/').pop();
        const mime = params.mime_type || 'application/octet-stream';
        const data = await sb.submitArtifact(getSessionId(), name, params.path, mime);
        const artifactId = data.artifact_id;
        const path = data.path || params.path;
        const displayName = data.name || name;
        const mimeType = data.mime_type || mime;
        const size = data.size != null ? data.size : undefined;
        return {
          content: [
            {
              type: 'text',
              text:
                `Artifact submitted: ${displayName} (artifact_id=${artifactId}, path=${path}` +
                (size != null ? `, size=${size}` : '') +
                `)`,
            },
          ],
          details: {
            artifact_id: artifactId,
            path,
            name: displayName,
            mime_type: mimeType,
            size,
          },
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          details: { isError: true },
        };
      }
    }),
  };

  // ── Tool: ls (structured, sandbox-backed) ───────

  const lsTool = {
    name: 'ls',
    label: 'List Directory',
    description:
      'List files and directories in the sandbox workspace (structured, bounded). ' +
      'Prefer this over bash ls. Max depth 5, max 1000 items. Relative, logical workspace, and /tmp paths are accepted.',
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({ description: 'Relative, logical workspace, or /tmp directory (default: .)' }),
      ),
      depth: Type.Optional(
        Type.Number({ description: 'Recursion depth 0–5 (default: 1)' }),
      ),
      include_hidden: Type.Optional(
        Type.Boolean({ description: 'Include dotfiles (default: false)' }),
      ),
    }),
    execute: wrapExecute('ls', async (_toolCallId, params) => {
      try {
        const data = await sb.lsFiles(getSessionId(), {
          path: params.path ?? '.',
          depth: params.depth ?? 1,
          include_hidden: Boolean(params.include_hidden),
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
          details: {
            matched: data.stats?.matched,
            truncated: data.truncated,
            stop_reason: data.stop_reason,
          },
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          details: { isError: true },
        };
      }
    }),
  };

  // ── Tool: find (structured, sandbox-backed) ─────

  const findTool = {
    name: 'find',
    label: 'Find Files',
    description:
      'Find files by glob pattern in the sandbox workspace (structured, bounded). ' +
      'Prefer this over bash find. Default max_depth 20, max 500 items.',
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({ description: 'Relative, logical workspace, or /tmp start path (default: .)' }),
      ),
      pattern: Type.Optional(
        Type.String({ description: 'Glob pattern (default: *)' }),
      ),
      type: Type.Optional(
        Type.String({ description: 'Optional filter: file | dir | symlink' }),
      ),
      max_depth: Type.Optional(
        Type.Number({ description: 'Max recursion depth 0–20 (default: 20)' }),
      ),
      limit: Type.Optional(
        Type.Number({ description: 'Max results 1–500 (default: 500)' }),
      ),
    }),
    execute: wrapExecute('find', async (_toolCallId, params) => {
      try {
        const data = await sb.findFiles(getSessionId(), {
          path: params.path ?? '.',
          pattern: params.pattern ?? '*',
          type: params.type,
          max_depth: params.max_depth,
          limit: params.limit,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
          details: {
            matched: data.stats?.matched,
            truncated: data.truncated,
            stop_reason: data.stop_reason,
          },
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          details: { isError: true },
        };
      }
    }),
  };

  // ── Tool: grep (structured, sandbox-backed) ─────

  const grepTool = {
    name: 'grep',
    label: 'Search Text',
    description:
      'Search file contents in the sandbox workspace (structured, bounded). ' +
      'Prefer this over bash grep. Default is literal text; set regex=true for restricted regex. ' +
      'Skips binary/large files. Max 500 matches, 5s timeout.',
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({ description: 'Relative, logical workspace, or /tmp start path (default: .)' }),
      ),
      query: Type.String({ description: 'Search string or regex' }),
      glob: Type.Optional(
        Type.String({ description: 'Optional filename glob filter (e.g. *.py)' }),
      ),
      regex: Type.Optional(
        Type.Boolean({ description: 'Treat query as regex (default: false)' }),
      ),
      case_sensitive: Type.Optional(
        Type.Boolean({ description: 'Case-sensitive match (default: true)' }),
      ),
      context: Type.Optional(
        Type.Number({ description: 'Context lines each side 0–5 (default: 0)' }),
      ),
      limit: Type.Optional(
        Type.Number({ description: 'Max matches 1–500 (default: 500)' }),
      ),
    }),
    execute: wrapExecute('grep', async (_toolCallId, params) => {
      if (!params.query || !String(params.query).trim()) {
        return {
          content: [{ type: 'text', text: 'Error: query is required' }],
          details: { isError: true },
        };
      }
      try {
        const data = await sb.grepFiles(getSessionId(), {
          path: params.path ?? '.',
          query: params.query,
          glob: params.glob,
          regex: Boolean(params.regex),
          case_sensitive: params.case_sensitive !== false,
          context: params.context,
          limit: params.limit,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
          details: {
            matched: data.stats?.matched,
            truncated: data.truncated,
            stop_reason: data.stop_reason,
          },
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          details: { isError: true },
        };
      }
    }),
  };

  // ── Managed process tools (B2) ──────────────────
  // Long-running / background / interactive processes. Sync bash stays for short commands.

  const processStartTool = {
    name: 'process_start',
    label: 'Start Process',
    description:
      'Start a managed long-running process in the sandbox (web server, watcher, REPL). ' +
      'Returns process_id immediately. Use process_logs / process_status / process_wait to observe. ' +
      'Do not use nohup or shell backgrounding (&) — the platform must own the process lifecycle. ' +
      'For short one-shot commands prefer bash.',
    parameters: Type.Object({
      command: Type.String({ description: 'Shell command to run' }),
      cwd: Type.Optional(
        Type.String({ description: 'Relative, logical workspace, or /tmp directory (default: .)' }),
      ),
      env: Type.Optional(Type.Record(Type.String(), Type.String())),
      timeout: Type.Optional(
        Type.Number({ description: 'Seconds before timeout kill; omit for no limit' }),
      ),
      background: Type.Optional(
        Type.Boolean({
          description: 'If true, process may outlive a single run (default false / foreground)',
        }),
      ),
    }),
    execute: wrapExecute('process_start', async (_toolCallId, params) => {
      const guard = skillRootGuard('bash', { command: params.command });
      if (guard.blocked) {
        return {
          content: [{ type: 'text', text: `Blocked (policy): ${guard.reason}` }],
          details: { isError: true, policy_version: POLICY_VERSION },
          isError: true,
        };
      }
      try {
        const sessionId = getSessionId();
        if (!sessionId) {
          return {
            content: [{ type: 'text', text: 'Error: no sandbox session' }],
            details: { isError: true },
            isError: true,
          };
        }
        const r = await sb.startProcess({
          session_id: sessionId,
          command: params.command,
          cwd: params.cwd,
          env: params.env,
          timeout: params.timeout,
          background: Boolean(params.background),
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  process_id: r.process_id,
                  status: r.status,
                  started_at: r.started_at,
                },
                null,
                2,
              ),
            },
          ],
          details: {
            process_id: r.process_id,
            status: r.status,
            started_at: r.started_at,
          },
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          details: { isError: true },
          isError: true,
        };
      }
    }),
  };

  const processStatusTool = {
    name: 'process_status',
    label: 'Process Status',
    description: 'Get status of a managed process (running, completed, failed, cancelled, …).',
    parameters: Type.Object({
      process_id: Type.String({ description: 'Process id from process_start' }),
    }),
    execute: wrapExecute('process_status', async (_toolCallId, params) => {
      try {
        const r = await sb.getProcess(params.process_id);
        return {
          content: [{ type: 'text', text: JSON.stringify(r, null, 2) }],
          details: {
            process_id: r.process_id,
            status: r.status,
            exit_code: r.exit_code,
          },
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          details: { isError: true },
          isError: true,
        };
      }
    }),
  };

  const processLogsTool = {
    name: 'process_logs',
    label: 'Process Logs',
    description:
      'Read stdout/stderr of a managed process from an offset. ' +
      'Poll with next_offset until completed is true.',
    parameters: Type.Object({
      process_id: Type.String({ description: 'Process id from process_start' }),
      offset: Type.Optional(Type.Number({ description: 'Log offset (default 0)' })),
      limit: Type.Optional(Type.Number({ description: 'Max characters to return' })),
    }),
    execute: wrapExecute('process_logs', async (_toolCallId, params) => {
      try {
        const r = await sb.getProcessLogs(
          params.process_id,
          params.offset || 0,
          params.limit != null ? params.limit : null,
        );
        const out = [
          r.stdout ? `STDOUT:\n${r.stdout}` : '',
          r.stderr ? `STDERR:\n${r.stderr}` : '',
          `next_offset=${r.next_offset} completed=${r.completed} truncated=${r.truncated}`,
        ]
          .filter(Boolean)
          .join('\n\n');
        return {
          content: [{ type: 'text', text: out || '(no output yet)' }],
          details: {
            next_offset: r.next_offset,
            completed: r.completed,
            truncated: r.truncated,
          },
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          details: { isError: true },
          isError: true,
        };
      }
    }),
  };

  const processWaitTool = {
    name: 'process_wait',
    label: 'Wait Process',
    description: 'Block until a managed process reaches a terminal state (or timeout).',
    parameters: Type.Object({
      process_id: Type.String({ description: 'Process id from process_start' }),
      timeout: Type.Optional(
        Type.Number({ description: 'Seconds to wait (omit to wait until done)' }),
      ),
    }),
    execute: wrapExecute('process_wait', async (_toolCallId, params) => {
      try {
        const r = await sb.waitProcess(
          params.process_id,
          params.timeout != null ? params.timeout : null,
        );
        return {
          content: [{ type: 'text', text: JSON.stringify(r, null, 2) }],
          details: {
            process_id: r.process_id,
            status: r.status,
            exit_code: r.exit_code,
          },
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          details: { isError: true },
          isError: true,
        };
      }
    }),
  };

  const processWriteStdinTool = {
    name: 'process_write_stdin',
    label: 'Process Stdin',
    description: 'Write text to a managed process stdin (interactive programs).',
    parameters: Type.Object({
      process_id: Type.String({ description: 'Process id from process_start' }),
      data: Type.String({ description: 'Text to write' }),
      eof: Type.Optional(Type.Boolean({ description: 'Close stdin after write' })),
    }),
    execute: wrapExecute('process_write_stdin', async (_toolCallId, params) => {
      try {
        const r = await sb.writeProcessStdin(
          params.process_id,
          params.data,
          Boolean(params.eof),
        );
        return {
          content: [{ type: 'text', text: JSON.stringify(r, null, 2) }],
          details: r,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          details: { isError: true },
          isError: true,
        };
      }
    }),
  };

  const processSignalTool = {
    name: 'process_signal',
    label: 'Signal Process',
    description: 'Send a POSIX signal to a managed process (SIGTERM, SIGINT, SIGKILL, …).',
    parameters: Type.Object({
      process_id: Type.String({ description: 'Process id from process_start' }),
      signal: Type.Optional(
        Type.String({ description: 'Signal name or number (default SIGTERM)' }),
      ),
    }),
    execute: wrapExecute('process_signal', async (_toolCallId, params) => {
      try {
        const r = await sb.signalProcess(params.process_id, params.signal || 'SIGTERM');
        return {
          content: [{ type: 'text', text: JSON.stringify(r, null, 2) }],
          details: r,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          details: { isError: true },
          isError: true,
        };
      }
    }),
  };

  const processCancelTool = {
    name: 'process_cancel',
    label: 'Cancel Process',
    description: 'Cancel (stop) a managed process. Idempotent after terminal state.',
    parameters: Type.Object({
      process_id: Type.String({ description: 'Process id from process_start' }),
    }),
    execute: wrapExecute('process_cancel', async (_toolCallId, params) => {
      try {
        const r = await sb.cancelProcess(params.process_id);
        return {
          content: [{ type: 'text', text: JSON.stringify(r, null, 2) }],
          details: {
            process_id: r.process_id,
            status: r.status,
            exit_code: r.exit_code,
          },
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          details: { isError: true },
          isError: true,
        };
      }
    }),
  };

  return [
    readTool,
    writeTool,
    editTool,
    applyPatchTool,
    bashTool,
    submitArtifactTool,
    lsTool,
    findTool,
    grepTool,
    processStartTool,
    processStatusTool,
    processLogsTool,
    processWaitTool,
    processWriteStdinTool,
    processSignalTool,
    processCancelTool,
  ];
}

async function readLocalSkill(path) {
  try {
    const fs = await import('fs/promises');
    const content = await fs.readFile(path, 'utf-8');
    return {
      content: [{ type: 'text', text: content }],
      details: { size: content.length, local: true },
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error reading skill: ${err.message}` }],
      details: { isError: true },
    };
  }
}

/**
 * @deprecated Module-level session globals are removed. Use createSandboxTools.
 * Kept as no-ops so accidental call sites do not reintroduce shared mutable state.
 */
export function setSandboxSessionId(_sid) {}
/** @deprecated Use createSandboxTools({ sessionId }). */
export function getSandboxSessionId() {
  return null;
}
/** @deprecated Use createSandboxTools({ approvalNotifier }). */
export function setApprovalNotifier(_fn) {}

/** @deprecated Prefer createSandboxTools for each chat turn. */
export const sandboxTools = createSandboxTools();
