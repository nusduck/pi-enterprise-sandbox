/**
 * Pi Enterprise Sandbox SDK — JSDoc type definitions.
 *
 * These types describe the shapes returned by the Sandbox API.
 * They are not exported as runtime values — they serve as
 * documentation for IDEs and editors that support JSDoc.
 *
 * Import them in your code for type hints:
 * ```js
 * /** @type {import('pi-enterprise-sandbox-sdk/types').SessionResponse} * /
 * ```
 *
 * @module pi-enterprise-sandbox-sdk/types
 */

/**
 * @typedef {object} SessionResponse
 * @property {string} session_id - Unique sandbox session identifier
 * @property {string} [agent_session_id] - Optional linked agent session
 * @property {string} [enterprise_session_id] - Optional linked enterprise session
 * @property {string} [user_id] - Optional user identifier
 * @property {string} caller_id - Identifier of the caller that created the session
 * @property {'RUNNING'|'COMPLETED'|'FAILED'} status - Current session status
 * @property {string} [workspace_path] - Path to the session workspace
 * @property {object} [metadata] - Arbitrary metadata
 * @property {string} created_at - ISO 8601 timestamp of creation
 * @property {string} [updated_at] - ISO 8601 timestamp of last update
 */

/**
 * @typedef {object} ExecutionResponse
 * @property {string} execution_id - Unique execution identifier
 * @property {'completed'|'running'|'failed'|'timeout'} status - Execution status
 * @property {number} [exit_code] - Process exit code
 * @property {string} [stdout_preview] - First portion of stdout output
 * @property {string} [stderr_preview] - First portion of stderr output
 * @property {string} [stdout_path] - Path to full stdout log on disk
 * @property {string} [stderr_path] - Path to full stderr log on disk
 * @property {number} [duration_ms] - Execution duration in milliseconds
 * @property {boolean} [truncated] - Whether output was truncated
 * @property {string} [error] - Error detail if execution failed
 */

/**
 * @typedef {object} FileResponse
 * @property {string} path - File path relative to workspace root
 * @property {string} content - File content (may be truncated)
 * @property {number} [size] - Total file size in bytes
 * @property {number} [offset] - Starting line/byte offset
 * @property {number} [limit] - Max lines/bytes returned
 * @property {boolean} [truncated] - Whether file content was truncated
 * @property {string} [mime_type] - MIME type of the file
 */

/**
 * @typedef {object} FileListEntry
 * @property {string} name - File or directory name
 * @property {'file'|'directory'} type - Entry type
 * @property {number} [size] - File size in bytes (files only)
 * @property {string} [modified_at] - ISO 8601 last-modified timestamp
 */

/**
 * @typedef {object} FileListResponse
 * @property {FileListEntry[]} files - List of files and directories
 * @property {number} total - Total number of entries
 */

/**
 * @typedef {object} ArtifactResponse
 * @property {string} artifact_id - Unique artifact identifier
 * @property {string} name - Human-readable artifact name
 * @property {string} path - Path relative to workspace root
 * @property {string} [mime_type] - MIME type of the artifact
 * @property {string} session_id - Session the artifact belongs to
 * @property {string} [source_execution_id] - Execution that produced it
 * @property {number} size - File size in bytes
 * @property {string} created_at - ISO 8601 timestamp
 */

/**
 * @typedef {object} ArtifactListResponse
 * @property {ArtifactResponse[]} artifacts - List of artifacts
 * @property {number} total - Total number of artifacts
 */

/**
 * @typedef {object} HealthResponse
 * @property {'ok'|'degraded'} status - Overall service status
 * @property {string} version - Service version string
 * @property {number} sessions_active - Currently active session count
 * @property {number} executions_total - Total executions processed
 * @property {boolean} workspace_available - Whether workspace storage is writable
 * @property {number} disk_free_mb - Free disk space in megabytes
 * @property {object} runtimes - Map of runtime name to availability
 * @property {boolean} runtimes.python - Python runtime available
 * @property {boolean} runtimes.bash - Bash runtime available
 * @property {boolean} runtimes.node - Node.js runtime available
 */

/**
 * @typedef {object} SandboxClientOptions
 * @property {string} sandboxUrl - Base URL of the Sandbox API
 * @property {string} [llmioApiKey] - Optional llm.io API key for proxied requests
 * @property {string} [modelId] - Optional model ID for proxied requests
 */

export default {};
