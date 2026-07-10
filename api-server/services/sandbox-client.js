/**
 * Sandbox HTTP Client — typed wrapper around fetch to the sandbox FastAPI service.
 *
 * Prefer `createSandboxClient({ traceId })` for request-scoped usage (chat turns).
 * Module-level helpers use ephemeral clients so concurrent requests never share
 * mutable trace state.
 */
import { randomUUID } from 'node:crypto';
import { config, AUTH_HEADER } from '../config.js';

const BASE = config.SANDBOX_BASE_URL;

export class SandboxError extends Error {
  constructor(status, message, path) {
    super(message);
    this.name = 'SandboxError';
    this.status = status;
    this.path = path;
  }
}

/**
 * Create a request-scoped sandbox client.
 * @param {{ traceId?: string|null }} [options]
 */
export function createSandboxClient({ traceId = null } = {}) {
  let clientTraceId = traceId || null;

  function setTraceId(id) {
    clientTraceId = id || null;
    return clientTraceId;
  }

  function getTraceId() {
    return clientTraceId;
  }

  function ensureTraceId(preferred) {
    if (preferred) {
      clientTraceId = preferred;
      return clientTraceId;
    }
    if (!clientTraceId) {
      clientTraceId = randomUUID();
    }
    return clientTraceId;
  }

  function headers(extra = {}) {
    const h = {
      'Content-Type': 'application/json',
      ...AUTH_HEADER,
      ...extra,
    };
    const tid = clientTraceId || extra['X-Trace-Id'];
    if (tid) {
      h['X-Trace-Id'] = tid;
      if (!clientTraceId) clientTraceId = tid;
    } else {
      const generated = randomUUID();
      clientTraceId = generated;
      h['X-Trace-Id'] = generated;
    }
    return h;
  }

  async function sbFetch(path, opts = {}) {
    const url = `${BASE}${path}`;
    const { headers: extraHeaders, ...rest } = opts;
    const resp = await fetch(url, {
      ...rest,
      headers: headers(extraHeaders || {}),
    });
    if (!resp.ok) {
      const detail = await resp.json().catch(() => ({ detail: resp.statusText }));
      throw new SandboxError(resp.status, detail.detail || resp.statusText, path);
    }
    return resp;
  }

  return {
    setTraceId,
    getTraceId,
    ensureTraceId,

    // ── Session ─────────────────────────────────────
    async createSession(callerId = 'pi-coding-agent', extra = {}) {
      const resp = await sbFetch('/sessions', {
        method: 'POST',
        body: JSON.stringify({ caller_id: callerId, ...extra }),
      });
      return resp.json();
    },

    async getSession(sessionId) {
      const resp = await sbFetch(`/sessions/${sessionId}`);
      return resp.json();
    },

    // ── Conversation ───────────────────────────────
    async listConversations() {
      const resp = await sbFetch('/conversations');
      return resp.json();
    },

    async createConversation(title = 'New chat') {
      const resp = await sbFetch('/conversations', {
        method: 'POST',
        body: JSON.stringify({ title }),
      });
      return resp.json();
    },

    async getConversation(conversationId) {
      const resp = await sbFetch(`/conversations/${conversationId}`);
      return resp.json();
    },

    async getConversationWorkspace(conversationId) {
      const resp = await sbFetch(`/conversations/${conversationId}/workspace`);
      return resp.json();
    },

    async updateConversation(conversationId, patch = {}) {
      const resp = await sbFetch(`/conversations/${conversationId}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      return resp.json();
    },

    async deleteConversation(conversationId) {
      const resp = await sbFetch(`/conversations/${conversationId}`, {
        method: 'DELETE',
      });
      if (resp.status === 204) return { ok: true };
      const text = await resp.text();
      return text ? JSON.parse(text) : { ok: true };
    },

    // ── Execution ───────────────────────────────────
    async executeCommand(sessionId, command, timeout = 120) {
      const resp = await sbFetch(`/sessions/${sessionId}/executions/command`, {
        method: 'POST',
        body: JSON.stringify({ command, timeout }),
      });
      return resp.json();
    },

    async cancelExecution(sessionId, executionId) {
      const resp = await sbFetch(
        `/sessions/${sessionId}/executions/${encodeURIComponent(executionId)}/cancel`,
        { method: 'POST' },
      );
      return resp.json();
    },

    /** Cancel the active running execution for a session (if any). */
    async cancelActiveExecution(sessionId) {
      const resp = await sbFetch(`/sessions/${sessionId}/executions/cancel-active`, {
        method: 'POST',
      });
      return resp.json();
    },

    // ── Files ───────────────────────────────────────
    async readFile(sessionId, path) {
      const q = new URLSearchParams({ path });
      const resp = await sbFetch(`/sessions/${sessionId}/files/read?${q}`);
      return resp.json();
    },

    async readFileWithRange(sessionId, path, offset, limit) {
      const q = new URLSearchParams({ path });
      if (offset != null) q.set('offset', '' + offset);
      if (limit != null) q.set('limit', '' + limit);
      const resp = await sbFetch(`/sessions/${sessionId}/files/read?${q}`);
      return resp.json();
    },

    async writeFile(sessionId, path, content) {
      const resp = await sbFetch(`/sessions/${sessionId}/files/write`, {
        method: 'POST',
        body: JSON.stringify({ path, content }),
      });
      return resp.json();
    },

    async listFiles(sessionId, dir = '.') {
      const q = new URLSearchParams({ path: dir });
      const resp = await sbFetch(`/sessions/${sessionId}/files?${q}`);
      return resp.json();
    },

    async downloadFileStream(sessionId, path) {
      return sbFetch(`/sessions/${sessionId}/files/download?path=${encodeURIComponent(path)}`);
    },

    // ── Artifacts ───────────────────────────────────
    async registerArtifact(sessionId, name, path, mimeType, sourceExecutionId) {
      const resp = await sbFetch(`/sessions/${sessionId}/artifacts/register`, {
        method: 'POST',
        body: JSON.stringify({
          name,
          path,
          mime_type: mimeType,
          source_execution_id: sourceExecutionId,
        }),
      });
      return resp.json();
    },

    async submitArtifact(sessionId, name, path, mimeType) {
      const resp = await sbFetch(`/sessions/${sessionId}/artifacts/submit`, {
        method: 'POST',
        body: JSON.stringify({
          name,
          path,
          mime_type: mimeType || 'application/octet-stream',
        }),
      });
      return resp.json();
    },

    async listArtifacts(sessionId) {
      const resp = await sbFetch(`/sessions/${sessionId}/artifacts`);
      return resp.json();
    },

    artifactDownloadPath(sessionId, artifactId) {
      return `/sessions/${sessionId}/artifacts/${encodeURIComponent(artifactId)}/download`;
    },

    async downloadArtifactStream(sessionId, artifactId) {
      return sbFetch(this.artifactDownloadPath(sessionId, artifactId));
    },

    // ── Approvals ───────────────────────────────────
    async approvalCheck(sessionId, body) {
      const resp = await sbFetch(`/sessions/${sessionId}/executions/approval-check`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return resp.json();
    },

    async getApproval(approvalId) {
      const resp = await sbFetch(`/approvals/${encodeURIComponent(approvalId)}`);
      return resp.json();
    },

    async decideApproval(approvalId, decision) {
      const resp = await sbFetch('/approve', {
        method: 'POST',
        body: JSON.stringify({ approval_id: approvalId, decision }),
      });
      return resp.json();
    },

    // ── Health ──────────────────────────────────────
    async checkHealth() {
      try {
        const resp = await fetch(`${BASE}/health`, { headers: AUTH_HEADER });
        if (!resp.ok) return null;
        return resp.json();
      } catch {
        return null;
      }
    },
  };
}

// ── Module-level helpers (ephemeral client per call — no shared request state) ──

/** @deprecated Prefer createSandboxClient({ traceId }). No shared mutable state. */
export function setTraceId(_id) {
  return null;
}

/** @deprecated Prefer client.getTraceId() from createSandboxClient. */
export function getTraceId() {
  return null;
}

/** Generate or return a preferred trace id without mutating shared state. */
export function ensureTraceId(preferred) {
  return preferred || randomUUID();
}

export function artifactDownloadPath(sessionId, artifactId) {
  return `/sessions/${sessionId}/artifacts/${encodeURIComponent(artifactId)}/download`;
}

export async function createSession(callerId = 'pi-coding-agent', extra = {}) {
  return createSandboxClient().createSession(callerId, extra);
}

export async function getSession(sessionId) {
  return createSandboxClient().getSession(sessionId);
}

export async function listConversations() {
  return createSandboxClient().listConversations();
}

export async function createConversation(title = 'New chat') {
  return createSandboxClient().createConversation(title);
}

export async function getConversation(conversationId) {
  return createSandboxClient().getConversation(conversationId);
}

export async function getConversationWorkspace(conversationId) {
  return createSandboxClient().getConversationWorkspace(conversationId);
}

export async function updateConversation(conversationId, patch = {}) {
  return createSandboxClient().updateConversation(conversationId, patch);
}

export async function deleteConversation(conversationId) {
  return createSandboxClient().deleteConversation(conversationId);
}

export async function executeCommand(sessionId, command, timeout = 120) {
  return createSandboxClient().executeCommand(sessionId, command, timeout);
}

export async function cancelExecution(sessionId, executionId) {
  return createSandboxClient().cancelExecution(sessionId, executionId);
}

export async function cancelActiveExecution(sessionId) {
  return createSandboxClient().cancelActiveExecution(sessionId);
}

export async function readFile(sessionId, path) {
  return createSandboxClient().readFile(sessionId, path);
}

export async function readFileWithRange(sessionId, path, offset, limit) {
  return createSandboxClient().readFileWithRange(sessionId, path, offset, limit);
}

export async function writeFile(sessionId, path, content) {
  return createSandboxClient().writeFile(sessionId, path, content);
}

export async function listFiles(sessionId, dir = '.') {
  return createSandboxClient().listFiles(sessionId, dir);
}

export async function downloadFileStream(sessionId, path) {
  return createSandboxClient().downloadFileStream(sessionId, path);
}

export async function registerArtifact(sessionId, name, path, mimeType, sourceExecutionId) {
  return createSandboxClient().registerArtifact(sessionId, name, path, mimeType, sourceExecutionId);
}

export async function submitArtifact(sessionId, name, path, mimeType) {
  return createSandboxClient().submitArtifact(sessionId, name, path, mimeType);
}

export async function listArtifacts(sessionId) {
  return createSandboxClient().listArtifacts(sessionId);
}

export async function downloadArtifactStream(sessionId, artifactId) {
  return createSandboxClient().downloadArtifactStream(sessionId, artifactId);
}

export async function approvalCheck(sessionId, body) {
  return createSandboxClient().approvalCheck(sessionId, body);
}

export async function getApproval(approvalId) {
  return createSandboxClient().getApproval(approvalId);
}

export async function decideApproval(approvalId, decision) {
  return createSandboxClient().decideApproval(approvalId, decision);
}

export async function checkHealth() {
  return createSandboxClient().checkHealth();
}
