/**
 * Sandbox security governance helpers + SDK Extension factory.
 *
 * Dual-enforcement model:
 * - Agent layer (this module + createSandboxTools): early policy, approval UX,
 *   write serialization, audit meta injection.
 * - Sandbox layer: independent hard-deny / path / session / approval checks.
 *
 * Extension exceptions are fail-closed (block the tool).
 *
 * Skill tree writes: generic write/edit/bash cannot target skill roots;
 * only dedicated skill_* tools (development mode) may mutate skills.
 */
import {
  DEFAULT_SKILL_ROOTS,
  isUnderSkillRoot,
  commandTouchesSkillRoot,
  isReadonlySkillExecution,
} from '../skills/paths.js';

/** Immutable policy catalog version echoed in audits and approval responses. */
export const POLICY_VERSION = '2026-07-11.2';

/** Side-effect classes for concurrency control. */
export const TOOL_SIDE_EFFECT = Object.freeze({
  READ: 'read',
  WRITE: 'write',
});

/** Three-tier policy decisions. */
export const POLICY_DECISION = Object.freeze({
  ALLOW: 'allow',
  APPROVAL_REQUIRED: 'approval_required',
  HARD_DENY: 'hard_deny',
});

/** Known safe-parallel (read-only) tools. */
const READ_TOOLS = new Set([
  'read',
  'read_file',
  'ls',
  'find',
  'grep',
  'list_files',
  'preview_file',
  'view_file',
  'cat',
  'head',
  'tail',
  // Process Manager read/observe tools
  'process_status',
  'process_logs',
  'process_wait',
]);

/** Known write / side-effect tools (serial per workspace). */
const WRITE_TOOLS = new Set([
  'write',
  'write_file',
  'edit',
  'edit_file',
  'apply_patch',
  'bash',
  'command',
  'raw_bash',
  'raw_shell',
  'submit_artifact',
  'delete_file',
  'network_request',
  'package_install',
  'pip_install',
  'npm_install',
  'kill_process',
  'run_python',
  // Process Manager control tools
  'process_start',
  'process_write_stdin',
  'process_signal',
  'process_cancel',
  // Skill management (development mode only; still serial write-class)
  'skill_install',
  'skill_edit',
  'skill_reload',
]);

/** MCP tools are treated as write-class by default (unknown side effects). */
function isMcpTool(toolName) {
  return typeof toolName === 'string' && toolName.startsWith('mcp_');
}

/** Generic tools that must never write the shared skill tree. */
const SKILL_ROOT_BLOCKED_TOOLS = new Set([
  'write',
  'write_file',
  'edit',
  'edit_file',
  'apply_patch',
  'bash',
  'command',
  'raw_bash',
  'raw_shell',
  'submit_artifact',
  'delete_file',
]);

/** Always blocked command prefixes (hard deny; cannot be approved). */
const HARD_DENY_PREFIXES = [
  'sudo',
  'su ',
  'chmod 777',
  'chown ',
  'rm -rf /',
  'rm -rf /*',
  'dd if=',
  'mkfs.',
  'fdisk',
  '> /dev/',
  '< /dev/',
];

/** Bash substrings that elevate to human approval when APPROVAL_ENABLED. */
const APPROVAL_REQUIRED_SUBSTRINGS = [
  'rm -rf',
  'rm -r ',
  'mkfs',
  'dd if=',
  'curl ',
  'wget ',
  'nc ',
  'ncat ',
  'pip install',
  'pip3 install',
  'npm install',
  'npm i ',
  'yarn add',
  'pnpm add',
  'chmod ',
  'chown ',
  'kill ',
  'pkill ',
  'eval ',
  'base64 -d',
];

/** Tools that are always high-risk (approval_required unless hard-denied). */
const HIGH_RISK_TOOLS = new Set([
  'raw_bash',
  'raw_shell',
  'delete_file',
  'network_request',
  'package_install',
  'pip_install',
  'npm_install',
  'kill_process',
  // Arbitrary signals can be destructive; cancel is a managed lifecycle op (not high-risk).
  'process_signal',
]);

/**
 * Classify tool concurrency class. Unknown tools are treated as write (serial).
 * @param {string} toolName
 * @returns {'read' | 'write'}
 */
export function classifyToolSideEffect(toolName) {
  const name = String(toolName || '').trim();
  if (!name) return TOOL_SIDE_EFFECT.WRITE;
  if (READ_TOOLS.has(name)) return TOOL_SIDE_EFFECT.READ;
  if (WRITE_TOOLS.has(name) || isMcpTool(name)) return TOOL_SIDE_EFFECT.WRITE;
  // Unknown tools default to write (serial + fail-closed approval path)
  return TOOL_SIDE_EFFECT.WRITE;
}

/**
 * @param {string} command
 * @returns {boolean}
 */
export function isHardDenyCommand(command) {
  const cmd = String(command || '').trim();
  if (!cmd) return false;
  const lower = cmd.toLowerCase();
  return HARD_DENY_PREFIXES.some((p) => lower.startsWith(p) || cmd.startsWith(p));
}

/**
 * @param {string} command
 * @returns {boolean}
 */
export function commandRequiresApproval(command) {
  const cmd = String(command || '').toLowerCase();
  if (!cmd) return false;
  return APPROVAL_REQUIRED_SUBSTRINGS.some((s) => cmd.includes(s));
}

/**
 * Three-tier local policy evaluation (mirrors Sandbox ToolPolicyChecker).
 * @param {string} toolName
 * @param {{ command?: string, path?: string, timeout?: number, file_size?: number }} [params]
 * @param {{ skillRoots?: string[] }} [options]
 * @returns {{ decision: string, reason: string, risk_level: string, side_effect: string, policy_version: string }}
 */
export function evaluateToolPolicy(toolName, params = {}, options = {}) {
  const name = String(toolName || '').trim() || 'unknown';
  const side_effect = classifyToolSideEffect(name);
  const base = { side_effect, policy_version: POLICY_VERSION };
  const skillRoots = options.skillRoots || DEFAULT_SKILL_ROOTS;

  try {
    // Skill root path policy: generic tools cannot mutate shared skills
    if (SKILL_ROOT_BLOCKED_TOOLS.has(name)) {
      if (params.path && isUnderSkillRoot(params.path, skillRoots)) {
        return {
          ...base,
          decision: POLICY_DECISION.HARD_DENY,
          reason:
            'blocked: skill root is not writable via generic tools; use skill_install/skill_edit in development mode',
          risk_level: 'high',
        };
      }
      if (
        params.command &&
        ['bash', 'command', 'raw_bash', 'raw_shell'].includes(name) &&
        commandTouchesSkillRoot(params.command, skillRoots) &&
        !isReadonlySkillExecution(params.command, skillRoots)
      ) {
        return {
          ...base,
          decision: POLICY_DECISION.HARD_DENY,
          reason:
            'blocked: bash must not target skill root; use skill_install/skill_edit in development mode',
          risk_level: 'high',
        };
      }
    }

    if (HIGH_RISK_TOOLS.has(name) && !params.command) {
      return {
        ...base,
        decision: POLICY_DECISION.APPROVAL_REQUIRED,
        reason: 'high risk tool, requires human approval',
        risk_level: 'high',
      };
    }

    const commandTools = [
      'bash',
      'command',
      'raw_bash',
      'raw_shell',
      'process_start',
    ];
    if (params.command && commandTools.includes(name)) {
      if (isHardDenyCommand(params.command)) {
        const token = String(params.command).trim().split(/\s+/)[0] || 'command';
        return {
          ...base,
          decision: POLICY_DECISION.HARD_DENY,
          reason: `blocked command: ${token}`,
          risk_level: 'high',
        };
      }
      if (commandRequiresApproval(params.command)) {
        return {
          ...base,
          decision: POLICY_DECISION.APPROVAL_REQUIRED,
          reason: 'high risk tool/command, requires human approval',
          risk_level: 'high',
        };
      }
    }

    if (params.command && isHardDenyCommand(params.command)) {
      const token = String(params.command).trim().split(/\s+/)[0] || 'command';
      return {
        ...base,
        decision: POLICY_DECISION.HARD_DENY,
        reason: `blocked command prefix: ${token}`,
        risk_level: 'medium',
      };
    }

    // Sync bash max 300s; managed processes may run longer (timeout is optional TTL).
    if (
      params.timeout != null &&
      Number(params.timeout) > 300 &&
      !name.startsWith('process_')
    ) {
      return {
        ...base,
        decision: POLICY_DECISION.HARD_DENY,
        reason: 'timeout exceeds maximum allowed (300s)',
        risk_level: 'medium',
      };
    }

    if (params.file_size != null && Number(params.file_size) > 50 * 1024 * 1024) {
      return {
        ...base,
        decision: POLICY_DECISION.HARD_DENY,
        reason: 'file size exceeds 50MB limit',
        risk_level: 'medium',
      };
    }

    if (side_effect === TOOL_SIDE_EFFECT.READ || READ_TOOLS.has(name)) {
      return {
        ...base,
        decision: POLICY_DECISION.ALLOW,
        reason: 'low risk tool, auto-allowed',
        risk_level: 'low',
      };
    }

    // write/edit/submit_artifact/bash(safe) — medium, auto-allow with constraints
    return {
      ...base,
      decision: POLICY_DECISION.ALLOW,
      reason: 'medium risk tool, allowed with constraints',
      risk_level: 'medium',
    };
  } catch (err) {
    // Fail-closed on evaluation bugs
    return {
      ...base,
      decision: POLICY_DECISION.HARD_DENY,
      reason: `policy evaluation failed: ${err?.message || String(err)}`,
      risk_level: 'high',
    };
  }
}

/**
 * Map policy decision through APPROVAL_ENABLED.
 * When approval is off, approval_required becomes allow + bypass flag.
 * hard_deny is never overridden.
 *
 * @param {{ decision: string, reason: string, risk_level: string, side_effect?: string, policy_version?: string }} policy
 * @param {boolean} approvalEnabled
 */
export function applyApprovalSwitch(policy, approvalEnabled = true) {
  if (policy.decision === POLICY_DECISION.HARD_DENY) {
    return { ...policy, approval_bypassed: false };
  }
  if (policy.decision === POLICY_DECISION.APPROVAL_REQUIRED && !approvalEnabled) {
    return {
      ...policy,
      decision: POLICY_DECISION.ALLOW,
      reason: `${policy.reason} (approval bypassed: APPROVAL_ENABLED=false)`,
      approval_bypassed: true,
    };
  }
  return { ...policy, approval_bypassed: false };
}

/**
 * Build a redacted audit event for a tool call. Never includes secrets or full body.
 * @param {object} opts
 */
export function buildToolAuditEvent(opts = {}) {
  const {
    toolName,
    toolCallId = null,
    params = {},
    policy = null,
    phase = 'tool_call',
    durationMs = null,
    isError = null,
    resultSummary = null,
    error = null,
    meta = {},
  } = opts;

  const paramSummary = summarizeParams(toolName, params);
  return {
    event: phase,
    tool_name: toolName,
    tool_call_id: toolCallId,
    params_summary: paramSummary,
    decision: policy?.decision ?? null,
    risk_level: policy?.risk_level ?? null,
    reason: policy?.reason ?? null,
    approval_bypassed: Boolean(policy?.approval_bypassed),
    policy_version: policy?.policy_version || POLICY_VERSION,
    side_effect: policy?.side_effect || classifyToolSideEffect(toolName),
    duration_ms: durationMs,
    is_error: isError,
    result_summary: resultSummary,
    error: error ? String(error).slice(0, 200) : null,
    meta: {
      user_id: meta.user_id ?? meta.userId ?? null,
      organization_id: meta.organization_id ?? meta.orgId ?? null,
      conversation_id: meta.conversation_id ?? meta.conversationId ?? null,
      session_id: meta.session_id ?? meta.sessionId ?? null,
      trace_id: meta.trace_id ?? meta.traceId ?? null,
      workspace_key: meta.workspace_key ?? meta.workspaceKey ?? null,
      policy_version: policy?.policy_version || POLICY_VERSION,
    },
  };
}

/**
 * @param {string} toolName
 * @param {object} params
 */
function summarizeParams(toolName, params) {
  if (!params || typeof params !== 'object') return {};
  const out = {};
  if (params.path != null) out.path = String(params.path).slice(0, 200);
  if (params.command != null) {
    const cmd = String(params.command);
    out.command = cmd.length > 120 ? `${cmd.slice(0, 120)}…` : cmd;
  }
  if (params.timeout != null) out.timeout = params.timeout;
  if (params.name != null) out.name = String(params.name).slice(0, 100);
  if (params.content != null) out.content_bytes = String(params.content).length;
  if (params.old_string != null) out.old_string_len = String(params.old_string).length;
  if (params.new_string != null) out.new_string_len = String(params.new_string).length;
  if (toolName) out.tool = toolName;
  return out;
}

/**
 * Emit audit to stdout as structured JSON (no secrets).
 * @param {object} event
 * @param {((ev: object) => void) | null} [sink]
 */
export function emitToolAudit(event, sink = null) {
  const line = { ...event, ts: new Date().toISOString() };
  if (typeof sink === 'function') {
    try {
      sink(line);
    } catch {
      /* ignore sink errors */
    }
  }
  try {
    console.log(`[security-audit] ${JSON.stringify(line)}`);
  } catch {
    console.log('[security-audit] <unserializable>');
  }
}

/**
 * Per-workspace write mutex. Read tools may run in parallel; write tools serialize
 * per key (conversation_id or workspace id). Different keys run in parallel.
 */
export function createWriteMutex() {
  /** @type {Map<string, Promise<unknown>>} */
  const tails = new Map();

  /**
   * @template T
   * @param {string} key
   * @param {() => Promise<T> | T} fn
   * @returns {Promise<T>}
   */
  async function runExclusive(key, fn) {
    const k = String(key || 'default');
    const prev = tails.get(k) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    // Chain so the next waiter awaits our gate even if we throw
    const chained = prev.catch(() => {}).then(() => gate);
    tails.set(k, chained);

    await prev.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      // Opportunistic cleanup when this is still the tail
      if (tails.get(k) === chained) {
        // Keep resolved promise so concurrent joiners still order correctly
        tails.set(
          k,
          chained.then(() => undefined),
        );
      }
    }
  }

  return { runExclusive };
}

/** Process-wide default mutex (shared across chat turns in this process). */
export const workspaceWriteMutex = createWriteMutex();

/**
 * Resolve whether APPROVAL_ENABLED is on (default true).
 * @param {NodeJS.ProcessEnv | { APPROVAL_ENABLED?: string|boolean }} [env]
 */
export function resolveApprovalEnabled(env = process.env) {
  const raw = env?.APPROVAL_ENABLED;
  if (raw == null || String(raw).trim() === '') return true;
  if (typeof raw === 'boolean') return raw;
  return String(raw).toLowerCase() !== 'false';
}

/**
 * Create a pi-coding-agent Extension factory that enforces hard_deny on tool_call.
 * Approval UX remains in createSandboxTools (needs SSE notifier + polling).
 *
 * @param {{
 *   getMeta?: () => object,
 *   approvalEnabled?: boolean | (() => boolean),
 *   auditSink?: (ev: object) => void,
 *   onHardDeny?: (info: object) => void,
 * }} [ctx]
 * @returns {(pi: any) => void}
 */
export function createSandboxSecurityExtension(ctx = {}) {
  const getMeta = typeof ctx.getMeta === 'function' ? ctx.getMeta : () => ({});
  const auditSink = typeof ctx.auditSink === 'function' ? ctx.auditSink : null;
  const onHardDeny = typeof ctx.onHardDeny === 'function' ? ctx.onHardDeny : null;

  return function sandboxSecurityExtension(pi) {
    pi.on('tool_call', async (event) => {
      try {
        const toolName = event.toolName || event.name || 'unknown';
        const input = event.input || event.params || {};
        const approvalEnabled =
          typeof ctx.approvalEnabled === 'function'
            ? Boolean(ctx.approvalEnabled())
            : ctx.approvalEnabled !== false;

        let policy = evaluateToolPolicy(toolName, input);
        policy = applyApprovalSwitch(policy, approvalEnabled);

        const meta = getMeta() || {};
        emitToolAudit(
          buildToolAuditEvent({
            toolName,
            toolCallId: event.toolCallId || event.id || null,
            params: input,
            policy,
            phase: 'tool_call',
            meta,
          }),
          auditSink,
        );

        if (policy.decision === POLICY_DECISION.HARD_DENY) {
          if (onHardDeny) {
            try {
              onHardDeny({ toolName, reason: policy.reason, policy });
            } catch {
              /* ignore */
            }
          }
          return { block: true, reason: policy.reason };
        }
        return undefined;
      } catch (err) {
        // Fail-closed: any extension error blocks the tool
        const reason = `Security extension error (fail-closed): ${err?.message || String(err)}`;
        let safeMeta = {};
        try {
          safeMeta = typeof getMeta === 'function' ? getMeta() || {} : {};
        } catch {
          safeMeta = {};
        }
        try {
          emitToolAudit(
            buildToolAuditEvent({
              toolName: event?.toolName || 'unknown',
              toolCallId: event?.toolCallId || null,
              params: event?.input || {},
              policy: {
                decision: POLICY_DECISION.HARD_DENY,
                reason,
                risk_level: 'high',
                policy_version: POLICY_VERSION,
                side_effect: 'write',
              },
              phase: 'tool_call',
              error: reason,
              meta: safeMeta,
            }),
            auditSink,
          );
        } catch {
          /* audit must not break fail-closed block */
        }
        return { block: true, reason };
      }
    });

    pi.on('tool_result', async (event) => {
      try {
        const toolName = event.toolName || 'unknown';
        const meta = getMeta() || {};
        const contentText =
          Array.isArray(event.content) && event.content[0]?.text
            ? String(event.content[0].text).slice(0, 160)
            : null;
        emitToolAudit(
          buildToolAuditEvent({
            toolName,
            toolCallId: event.toolCallId || null,
            params: event.input || {},
            policy: {
              decision: null,
              reason: null,
              risk_level: null,
              policy_version: POLICY_VERSION,
              side_effect: classifyToolSideEffect(toolName),
            },
            phase: 'tool_result',
            isError: Boolean(event.isError),
            resultSummary: contentText,
            meta,
          }),
          auditSink,
        );
      } catch {
        // tool_result audit failures must not rewrite results or throw
      }
      return undefined;
    });
  };
}

/**
 * Pre-execute gate used by createSandboxTools.
 * Combines local hard_deny, write-class fail-closed policy, and optional remote check.
 *
 * @param {object} opts
 * @param {string} opts.toolName
 * @param {object} [opts.params]
 * @param {boolean} [opts.approvalEnabled]
 * @param {object} [opts.meta]
 * @param {(ev: object) => void} [opts.auditSink]
 * @returns {{ ok: boolean, reason?: string, policy: object, approval_bypassed?: boolean }}
 */
export function preExecuteGate({
  toolName,
  params = {},
  approvalEnabled = true,
  meta = {},
  auditSink = null,
} = {}) {
  try {
    let policy = evaluateToolPolicy(toolName, params);
    policy = applyApprovalSwitch(policy, approvalEnabled);
    emitToolAudit(
      buildToolAuditEvent({
        toolName,
        params,
        policy,
        phase: 'pre_execute',
        meta,
      }),
      auditSink,
    );
    if (policy.decision === POLICY_DECISION.HARD_DENY) {
      return { ok: false, reason: policy.reason, policy, approval_bypassed: false };
    }
    return {
      ok: true,
      policy,
      approval_bypassed: Boolean(policy.approval_bypassed),
      // Still needs remote approval when decision remains approval_required
      needs_approval: policy.decision === POLICY_DECISION.APPROVAL_REQUIRED,
    };
  } catch (err) {
    const reason = `pre-execute gate failed (fail-closed): ${err?.message || String(err)}`;
    const policy = {
      decision: POLICY_DECISION.HARD_DENY,
      reason,
      risk_level: 'high',
      policy_version: POLICY_VERSION,
      side_effect: classifyToolSideEffect(toolName),
    };
    emitToolAudit(
      buildToolAuditEvent({
        toolName,
        params,
        policy,
        phase: 'pre_execute',
        error: reason,
        meta,
      }),
      auditSink,
    );
    return { ok: false, reason, policy, approval_bypassed: false };
  }
}
