/**
 * Sandbox tool definitions for pi-coding-agent (4 built-in tools).
 * Each tool defers execution to the shared sandbox-client.js.
 *
 * Tools: read, write, edit, bash
 */
import { Type } from 'typebox';
import * as sb from './services/sandbox-client.js';

// Session ID — set before each agent turn
let _sessionId = null;
export function setSandboxSessionId(sid) { _sessionId = sid; }
export function getSandboxSessionId() { return _sessionId; }

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
    if (params.path.startsWith('/sandbox/skills/') || params.path.startsWith('/app/.pi/skills/') || params.path.startsWith('.pi/skills/')) {
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
  description: 'Write content to a file in the sandbox workspace.',
  parameters: Type.Object({
    path: Type.String({ description: 'File path' }),
    content: Type.String({ description: 'Content to write' }),
  }),
  execute: async (_toolCallId, params) => {
    try {
      const data = await sb.writeFile(_sessionId, params.path, params.content);
      return {
        content: [{ type: 'text', text: `Written ${data.size} bytes to ${params.path}` }],
        details: { size: data.size },
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
  description: 'Find-and-replace edit on a file in the sandbox workspace.',
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
  description: 'Run a shell command in the sandbox (Python, bash, node).',
  parameters: Type.Object({
    command: Type.String({ description: 'Shell command' }),
    timeout: Type.Optional(Type.Number({ description: 'Seconds (max 300)' })),
  }),
  execute: async (_toolCallId, params) => {
    try {
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
  description: 'Explicitly submit a workspace file as a downloadable artifact. Only explicitly submitted files are tracked — no automatic scans.',
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
      return {
        content: [{ type: 'text', text: `Artifact submitted: ${data.name} (${data.artifact_id})` }],
        details: { artifact_id: data.artifact_id, path: params.path },
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
