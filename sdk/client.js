/**
 * Pi Enterprise Sandbox SDK — REST API client for frontend developers.
 *
 * Pure ESM, no external dependencies. Uses native fetch() (Node 18+).
 *
 * @module pi-enterprise-sandbox-sdk/client
 */

// ── Custom error class ───────────────────────────────────────────────────

/**
 * Error returned by the Sandbox API.
 */
export class SandboxError extends Error {
  /**
   * @param {number} statusCode - HTTP status code
   * @param {string} message - Error message from the API or network
   * @param {object} [body] - Optional parsed response body
   */
  constructor(statusCode, message, body) {
    super(message);
    this.name = 'SandboxError';
    /** @type {number} */
    this.statusCode = statusCode;
    /** @type {object|undefined} */
    this.body = body;
  }
}

// ── Internal helpers ─────────────────────────────────────────────────────

/**
 * Build a full URL from the base sandbox URL and a path.
 * @param {string} base
 * @param {string} path
 * @returns {string}
 */
function url(base, path) {
  return `${base.replace(/\/+$/, '')}${path}`;
}

/**
 * Build a query-string segment for an object whose values may be undefined.
 * @param {Record<string, string|number|undefined|null>} params
 * @returns {string}
 */
function queryString(params) {
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    }
  }
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

/**
 * Throw a SandboxError for a non-OK response.
 * @param {Response} response
 * @returns {Promise<void>}
 */
async function throwOnError(response) {
  if (!response.ok) {
    let body;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    throw new SandboxError(
      response.status,
      (body && body.detail) || response.statusText || `HTTP ${response.status}`,
      body,
    );
  }
}

/**
 * Fetch and parse JSON, handling errors uniformly.
 * @param {string} baseUrl
 * @param {string} method
 * @param {string} path
 * @param {object} [options]
 * @param {object} [options.body]
 * @param {Record<string, string|number|undefined|null>} [options.query]
 * @param {Record<string, string>} [options.headers]
 * @returns {Promise<any>}
 */
async function request(baseUrl, method, path, { body, query, headers } = {}) {
  const fullUrl = url(baseUrl, path) + (query ? queryString(query) : '');

  /** @type {RequestInit} */
  const init = {
    method,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...headers,
    },
  };

  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(fullUrl, init);
  } catch (err) {
    throw new SandboxError(0, `Network error: ${err.message}`);
  }

  await throwOnError(response);

  // 204 No Content — return null
  if (response.status === 204) {
    return null;
  }

  return response.json();
}

// ── Client class ─────────────────────────────────────────────────────────

/**
 * Client for the Pi Enterprise Sandbox REST API.
 *
 * All methods return Promises. Errors are thrown as {@link SandboxError}.
 *
 * @example
 * ```js
 * import { SandboxClient } from 'pi-enterprise-sandbox-sdk';
 *
 * const client = new SandboxClient({ sandboxUrl: 'http://localhost:8083' });
 * const session = await client.createSession('my-app');
 * const result = await client.executeCommand(session.session_id, 'echo hello');
 * console.log(result.stdout_preview);
 * ```
 */
export class SandboxClient {
  /**
   * @param {object} options
   * @param {string} options.sandboxUrl - Base URL of the Sandbox API (e.g. `http://localhost:8083`)
   * @param {string} [options.llmioApiKey] - Optional llm.io API key for proxied requests
   * @param {string} [options.modelId] - Optional model ID for proxied requests
   */
  constructor(options) {
    const { sandboxUrl, llmioApiKey, modelId } = options || {};

    if (!sandboxUrl) {
      throw new Error('SandboxClient requires a `sandboxUrl` option');
    }

    /** @type {string} */
    this.baseUrl = sandboxUrl.replace(/\/+$/, '');

    /** @type {Record<string, string>} */
    this._headers = {};

    if (llmioApiKey) {
      this._headers['X-LLMIO-Api-Key'] = llmioApiKey;
    }
    if (modelId) {
      this._headers['X-Model-Id'] = modelId;
    }
  }

  // ── Session lifecycle ─────────────────────────────────────────────────

  /**
   * Create a new sandbox session.
   *
   * POST /sessions
   *
   * @param {string} [callerId='sdk-user'] - Identifier for the caller
   * @returns {Promise<SessionResponse>} The created session
   */
  createSession(callerId = 'sdk-user') {
    return request(this.baseUrl, 'POST', '/sessions', {
      body: { caller_id: callerId },
      headers: this._headers,
    });
  }

  /**
   * Get a session by its ID.
   *
   * GET /sessions/:id
   *
   * @param {string} id - Session ID
   * @returns {Promise<SessionResponse>}
   */
  getSession(id) {
    return request(this.baseUrl, 'GET', `/sessions/${encodeURIComponent(id)}`, {
      headers: this._headers,
    });
  }

  /**
   * Delete (close) a session.
   *
   * DELETE /sessions/:id
   *
   * @param {string} id - Session ID
   * @returns {Promise<null>}
   */
  deleteSession(id) {
    return request(this.baseUrl, 'DELETE', `/sessions/${encodeURIComponent(id)}`, {
      headers: this._headers,
    });
  }

  // ── Execution ─────────────────────────────────────────────────────────

  /**
   * Execute a shell command in a session's workspace.
   *
   * POST /sessions/:id/executions/command
   *
   * @param {string} sessionId - Session ID
   * @param {string} command - Shell command to run
   * @param {number} [timeout] - Maximum execution time in seconds
   * @returns {Promise<ExecutionResponse>}
   */
  executeCommand(sessionId, command, timeout) {
    /** @type {Record<string, any>} */
    const body = { command };
    if (timeout !== undefined) {
      body.timeout = timeout;
    }
    return request(
      this.baseUrl,
      'POST',
      `/sessions/${encodeURIComponent(sessionId)}/executions/command`,
      { body, headers: this._headers },
    );
  }

  /**
   * Execute Python code in a session's workspace.
   *
   * POST /sessions/:id/executions/python
   *
   * @param {string} sessionId - Session ID
   * @param {string} code - Python source code
   * @param {number} [timeout] - Maximum execution time in seconds
   * @returns {Promise<ExecutionResponse>}
   */
  executePython(sessionId, code, timeout) {
    /** @type {Record<string, any>} */
    const body = { code };
    if (timeout !== undefined) {
      body.timeout = timeout;
    }
    return request(
      this.baseUrl,
      'POST',
      `/sessions/${encodeURIComponent(sessionId)}/executions/python`,
      { body, headers: this._headers },
    );
  }

  // ── File operations ───────────────────────────────────────────────────

  /**
   * Read a file from a session's workspace.
   *
   * GET /sessions/:id/files/read
   *
   * @param {string} sessionId - Session ID
   * @param {string} path - Path relative to workspace root
   * @param {number} [offset] - Line offset (1-indexed)
   * @param {number} [limit] - Max lines / bytes to read
   * @returns {Promise<FileResponse>}
   */
  readFile(sessionId, path, offset, limit) {
    return request(
      this.baseUrl,
      'GET',
      `/sessions/${encodeURIComponent(sessionId)}/files/read`,
      {
        query: { path, offset, limit },
        headers: this._headers,
      },
    );
  }

  /**
   * Write content to a file in a session's workspace.
   *
   * POST /sessions/:id/files/write
   *
   * @param {string} sessionId - Session ID
   * @param {string} path - Path relative to workspace root
   * @param {string} content - File content
   * @returns {Promise<FileResponse>}
   */
  writeFile(sessionId, path, content) {
    return request(
      this.baseUrl,
      'POST',
      `/sessions/${encodeURIComponent(sessionId)}/files/write`,
      {
        body: { path, content },
        headers: this._headers,
      },
    );
  }

  /**
   * List files in a session's workspace directory.
   *
   * GET /sessions/:id/files
   *
   * @param {string} sessionId - Session ID
   * @param {string} [path='.'] - Directory path relative to workspace root
   * @returns {Promise<FileListResponse>}
   */
  listFiles(sessionId, path = '.') {
    return request(
      this.baseUrl,
      'GET',
      `/sessions/${encodeURIComponent(sessionId)}/files`,
      {
        query: { path },
        headers: this._headers,
      },
    );
  }

  // ── Artifacts ─────────────────────────────────────────────────────────

  /**
   * List artifacts for a session.
   *
   * GET /sessions/:id/artifacts
   *
   * @param {string} sessionId - Session ID
   * @returns {Promise<ArtifactListResponse>}
   */
  listArtifacts(sessionId) {
    return request(
      this.baseUrl,
      'GET',
      `/sessions/${encodeURIComponent(sessionId)}/artifacts`,
      { headers: this._headers },
    );
  }

  // ── Health ────────────────────────────────────────────────────────────

  /**
   * Check the Sandbox API health.
   *
   * GET /health
   *
   * @returns {Promise<HealthResponse>}
   */
  health() {
    return request(this.baseUrl, 'GET', '/health', { headers: this._headers });
  }
}
