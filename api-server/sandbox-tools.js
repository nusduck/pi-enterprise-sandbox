/**
 * Sandbox tool definitions for pi-coding-agent.
 * Each tool defers execution to a request-scoped sandbox client.
 *
 * Tools: read, write, edit, bash, submit_artifact, ls, find, grep
 *
 * Prefer createSandboxTools({ client, sessionId|getSessionId, approvalNotifier })
 * so concurrent chat turns never share session/approval state.
 *
 * Security:
 * - preExecuteGate + ensureApproved (fail-closed for write tools)
 * - workspace write mutex for serial side-effect tools
 * - APPROVAL_ENABLED maps approval_required → execute + bypass audit;
 *   hard_deny is never overridden
 *
 * NOTE: createAgentSession({ tools: [...] }) is an allowlist — every tool
 * name here must also appear in that list or the model will not see it.
 */
import { Type } from 'typebox';
import * as defaultSb from './services/sandbox-client.js';
import { config } from './config.js';
import {
  POLICY_VERSION,
  classifyToolSideEffect,
  preExecuteGate,
  workspaceWriteMutex,
  emitToolAudit,
  buildToolAuditEvent,
  POLICY_DECISION,
} from './extensions/sandbox-security.js';

const APPROVAL_POLL_MS = 1500;
const APPROVAL_MAX_WAIT_MS = 5 * 60 * 1000;

/**
 * @typedef {object} SandboxToolsContext
 * @property {ReturnType<typeof defaultSb.createSandboxClient> | typeof defaultSb} [client]
 * @property {string | null} [sessionId]
 * @property {() => string | null | undefined} [getSessionId]
 * @property {() => string | null | undefined} [getWorkspaceKey]
 * @property {((ev: object) => void) | null} [approvalNotifier]
 * @property {boolean} [approvalEnabled]
 * @property {() => object} [getMeta]
 * @property {((ev: object) => void) | null} [auditSink]
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
  const approvalEnabled =
    ctx.approvalEnabled != null ? Boolean(ctx.approvalEnabled) : config.APPROVAL_ENABLED !== false;
  const getMeta = typeof ctx.getMeta === 'function' ? ctx.getMeta : () => ({});
  const auditSink = typeof ctx.auditSink === 'function' ? ctx.auditSink : null;

  function metaNow() {
    return {
      session_id: getSessionId(),
      workspace_key: getWorkspaceKey(),
      policy_version: POLICY_VERSION,
      ...getMeta(),
    };
  }

  /**
   * Run policy check; if pending, notify UI and poll until approved/rejected/timeout.
   * Fail-closed for all write-class tools when the check endpoint errors.
   * When APPROVAL_ENABLED=false, remote may auto-approve with bypass; local
   * hard_deny still blocks before this is called.
   *
   * @returns {Promise<{ ok: boolean, reason?: string, approval_id?: string, policy_version?: string, approval_bypassed?: boolean }>}
   */
  async function ensureApproved(toolName, params = {}) {
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
      approvalEnabled,
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
      });
    } catch (err) {
      // Fail-closed for write-class tools (includes bash, write, edit, submit_artifact, unknown)
      const side = classifyToolSideEffect(toolName);
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
      return {
        ok: true,
        policy_version: check.policy_version || POLICY_VERSION,
        approval_bypassed: Boolean(check.approval_bypassed),
      };
    }
    if (check.status === 'rejected') {
      return {
        ok: false,
        reason: check.reason || 'Rejected by policy',
        policy_version: check.policy_version || POLICY_VERSION,
      };
    }
    if (check.status !== 'pending_approval' || !check.approval_id) {
      return {
        ok: false,
        reason: check.reason || 'Not allowed',
        policy_version: check.policy_version || POLICY_VERSION,
      };
    }

    // If approvals disabled client-side but sandbox still returned pending, fail-closed
    // only when we expected bypass — prefer trust sandbox; if APPROVAL_ENABLED false,
    // treat pending as execute (audit was on sandbox when configured consistently).
    if (!approvalEnabled) {
      emitToolAudit(
        buildToolAuditEvent({
          toolName,
          params,
          policy: {
            decision: POLICY_DECISION.ALLOW,
            reason: 'approval bypassed client-side (APPROVAL_ENABLED=false)',
            risk_level: check.risk_level || 'high',
            policy_version: check.policy_version || POLICY_VERSION,
            approval_bypassed: true,
            side_effect: classifyToolSideEffect(toolName),
          },
          phase: 'approval_bypass',
          meta: metaNow(),
        }),
        auditSink,
      );
      return {
        ok: true,
        approval_id: check.approval_id,
        policy_version: check.policy_version || POLICY_VERSION,
        approval_bypassed: true,
      };
    }

    const approvalId = check.approval_id;
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
      });
    }

    const deadline = Date.now() + APPROVAL_MAX_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, APPROVAL_POLL_MS));
      try {
        const st = await sb.getApproval(approvalId);
        if (st.status === 'approved') {
          return {
            ok: true,
            approval_id: approvalId,
            policy_version: check.policy_version || POLICY_VERSION,
          };
        }
        if (st.status === 'rejected') {
          return {
            ok: false,
            reason: st.reason || 'Rejected by operator',
            approval_id: approvalId,
            policy_version: check.policy_version || POLICY_VERSION,
          };
        }
      } catch {
        // keep polling until timeout
      }
    }
    return {
      ok: false,
      reason: 'Approval timed out',
      approval_id: approvalId,
      policy_version: check.policy_version || POLICY_VERSION,
    };
  }

  /**
   * Wrap execute with write mutex + approval gate for write-class tools.
   * @param {string} toolName
   * @param {Function} executeFn
   */
  function wrapExecute(toolName, executeFn) {
    return async (toolCallId, params, ...rest) => {
      const side = classifyToolSideEffect(toolName);
      const run = async () => {
        if (side === 'write') {
          const gate = await ensureApproved(toolName, params || {});
          if (!gate.ok) {
            return {
              content: [{ type: 'text', text: `Blocked (policy): ${gate.reason}` }],
              details: {
                isError: true,
                approval_id: gate.approval_id,
                policy_version: gate.policy_version || POLICY_VERSION,
              },
              isError: true,
            };
          }
        }
        return executeFn(toolCallId, params, ...rest);
      };

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
    description: 'Read file contents from the sandbox workspace.',
    parameters: Type.Object({
      path: Type.String({ description: 'File path (relative to workspace)' }),
      offset: Type.Optional(Type.Number({ description: 'Start line (1-indexed)' })),
      limit: Type.Optional(Type.Number({ description: 'Max lines' })),
    }),
    execute: wrapExecute('read', async (_toolCallId, params) => {
      // Skill files: read from api-server local FS, not sandbox
      if (
        params.path.startsWith('/home/sandbox/skill/') ||
        params.path.startsWith('/sandbox/skills/') ||
        params.path.startsWith('/app/.pi/skills/') ||
        params.path.startsWith('.pi/skills/')
      ) {
        return readLocalSkill(params.path);
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
      'Write content to a private file in the sandbox workspace. ' +
      'Does NOT share the file with the user or create a download link. ' +
      'To deliver a file to the user, call submit_artifact after writing.',
    parameters: Type.Object({
      path: Type.String({ description: 'File path' }),
      content: Type.String({ description: 'Content to write' }),
    }),
    execute: wrapExecute('write', async (_toolCallId, params) => {
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

  // ── Tool: edit — read → replace → write ────────

  const editTool = {
    name: 'edit',
    label: 'Edit File',
    description:
      'Find-and-replace edit on a private file in the sandbox workspace. ' +
      'Does NOT share the file with the user. Call submit_artifact to deliver a file.',
    parameters: Type.Object({
      path: Type.String({ description: 'File path' }),
      old_string: Type.String({ description: 'Text to find' }),
      new_string: Type.String({ description: 'Replacement text' }),
    }),
    execute: wrapExecute('edit', async (_toolCallId, params) => {
      try {
        const sessionId = getSessionId();
        const file = await sb.readFile(sessionId, params.path);
        const content = file.content || '';
        const idx = content.lastIndexOf(params.old_string);
        if (idx === -1) {
          return {
            content: [{ type: 'text', text: `Error: old_string not found in ${params.path}` }],
            details: { isError: true },
          };
        }
        const newContent =
          content.slice(0, idx) + params.new_string + content.slice(idx + params.old_string.length);
        await sb.writeFile(sessionId, params.path, newContent);
        return {
          content: [{ type: 'text', text: `Replaced in ${params.path}` }],
          details: { path: params.path },
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          details: { isError: true },
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
      path: Type.String({ description: 'File path relative to workspace' }),
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
      'Prefer this over bash ls. Max depth 5, max 1000 items. Paths are workspace-relative.',
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({ description: 'Directory path relative to workspace (default: .)' }),
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
        Type.String({ description: 'Start path relative to workspace (default: .)' }),
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
        Type.String({ description: 'Start path relative to workspace (default: .)' }),
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

  return [
    readTool,
    writeTool,
    editTool,
    bashTool,
    submitArtifactTool,
    lsTool,
    findTool,
    grepTool,
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
