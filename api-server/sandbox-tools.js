/**
 * Sandbox tool definitions for pi-coding-agent.
 * Each tool defers execution to the shared sandbox-client.js.
 *
 * Tools: read, write, edit, bash, submit_artifact
 *
 * NOTE: createAgentSession({ tools: [...] }) is an allowlist — every tool
 * name here must also appear in that list or the model will not see it.
 */
import { Type } from 'typebox';
import * as sb from './services/sandbox-client.js';

// Session ID — set before each agent turn
let _sessionId = null;
export function setSandboxSessionId(sid) { _sessionId = sid; }
export function getSandboxSessionId() { return _sessionId; }

/** Optional SSE notifier for approval_required (wired from chat.js). */
let _approvalNotifier = null;
export function setApprovalNotifier(fn) {
  _approvalNotifier = typeof fn === 'function' ? fn : null;
}

const APPROVAL_POLL_MS = 1500;
const APPROVAL_MAX_WAIT_MS = 5 * 60 * 1000;

/**
 * Run policy check; if pending, notify UI and poll until approved/rejected/timeout.
 * @returns {{ ok: boolean, reason?: string, approval_id?: string }}
 */
async function ensureApproved(toolName, params = {}) {
  if (!_sessionId) return { ok: true };
  let check;
  try {
    check = await sb.approvalCheck(_sessionId, {
      tool_name: toolName,
      command: params.command || null,
      path: params.path || null,
      timeout: params.timeout || null,
    });
  } catch (err) {
    // If check endpoint fails, fail closed for safety on bash
    if (toolName === 'bash') {
      return { ok: false, reason: `Approval check failed: ${err.message}` };
    }
    return { ok: true };
  }

  if (check.status === 'approved') return { ok: true };
  if (check.status === 'rejected') {
    return { ok: false, reason: check.reason || 'Rejected by policy' };
  }
  if (check.status !== 'pending_approval' || !check.approval_id) {
    return { ok: false, reason: check.reason || 'Not allowed' };
  }

  const approvalId = check.approval_id;
  if (_approvalNotifier) {
    _approvalNotifier({
      type: 'approval_required',
      approval_id: approvalId,
      tool_name: toolName,
      command: params.command,
      path: params.path,
      reason: check.reason,
      risk_level: check.risk_level,
    });
  }

  const deadline = Date.now() + APPROVAL_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, APPROVAL_POLL_MS));
    try {
      const st = await sb.getApproval(approvalId);
      if (st.status === 'approved') return { ok: true, approval_id: approvalId };
      if (st.status === 'rejected') {
        return { ok: false, reason: st.reason || 'Rejected by operator', approval_id: approvalId };
      }
    } catch {
      // keep polling until timeout
    }
  }
  return { ok: false, reason: 'Approval timed out', approval_id: approvalId };
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
  execute: async (_toolCallId, params) => {
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
      const q = new URLSearchParams({ path: params.path });
      if (params.offset != null) q.set('offset', '' + params.offset);
      if (params.limit != null) q.set('limit', '' + params.limit);
      const data = params.offset != null || params.limit != null
        ? await sb.readFileWithRange(_sessionId, params.path, params.offset, params.limit)
        : await sb.readFile(_sessionId, params.path);
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
  },
};

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
  execute: async (_toolCallId, params) => {
    try {
      const data = await sb.writeFile(_sessionId, params.path, params.content);
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
  },
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
  execute: async (_toolCallId, params) => {
    try {
      const file = await sb.readFile(_sessionId, params.path);
      const content = file.content || '';
      const idx = content.lastIndexOf(params.old_string);
      if (idx === -1) {
        return {
          content: [{ type: 'text', text: `Error: old_string not found in ${params.path}` }],
          details: { isError: true },
        };
      }
      const newContent = content.slice(0, idx) + params.new_string + content.slice(idx + params.old_string.length);
      await sb.writeFile(_sessionId, params.path, newContent);
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
  },
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
  execute: async (_toolCallId, params) => {
    try {
      const gate = await ensureApproved('bash', {
        command: params.command,
        timeout: params.timeout,
      });
      if (!gate.ok) {
        return {
          content: [{ type: 'text', text: `Blocked (approval): ${gate.reason}` }],
          details: { isError: true, approval_id: gate.approval_id },
          isError: true,
        };
      }
      const r = await sb.executeCommand(_sessionId, params.command, params.timeout || 120);
      const isErr = r.exit_code != null && r.exit_code !== 0;
      const out = [r.stdout_preview ? `STDOUT:\n${r.stdout_preview}` : '',
        r.stderr_preview ? `STDERR:\n${r.stderr_preview}` : ''].filter(Boolean).join('\n\n') || '(no output)';
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
  },
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
    mime_type: Type.Optional(Type.String({ description: 'MIME type (default: application/octet-stream)' })),
  }),
  execute: async (_toolCallId, params) => {
    try {
      const name = params.name || params.path.split('/').pop();
      const mime = params.mime_type || 'application/octet-stream';
      const data = await sb.submitArtifact(_sessionId, name, params.path, mime);
      const artifactId = data.artifact_id;
      const path = data.path || params.path;
      const displayName = data.name || name;
      const mimeType = data.mime_type || mime;
      const size = data.size != null ? data.size : undefined;
      return {
        content: [{
          type: 'text',
          text: `Artifact submitted: ${displayName} (artifact_id=${artifactId}, path=${path}` +
            (size != null ? `, size=${size}` : '') + `)`,
        }],
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
  },
};

export const sandboxTools = [readTool, writeTool, editTool, bashTool, submitArtifactTool];
