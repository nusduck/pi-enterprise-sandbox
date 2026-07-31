/**
 * sandbox-bridge constants (plan §13 / PR-06 B1).
 */

/** Exact 10 tool names — no more, no less. */
export const SANDBOX_TOOL_NAMES = Object.freeze([
  'read',
  'write',
  'edit',
  'bash',
  'python',
  'process_start',
  'process_status',
  'process_read',
  'process_kill',
  'submit_artifact',
]);

/** Tools that may run in parallel. */
export const PARALLEL_TOOLS = Object.freeze(
  new Set(['read', 'process_status', 'process_read']),
);

/**
 * Read pagination (Hermes-aligned model surface).
 * Sandbox wire remains 0-based offset; limit is lines.
 * Defaults stay small so the model pages instead of stuffing context.
 */
export const DEFAULT_READ_LIMIT = 500;
export const MAX_READ_LIMIT = 2_000;
/** Sandbox read hard cap (bytes of file content before bridge formatting). */
export const MAX_READ_BYTES = 256 * 1024;
/**
 * Model-facing character budget for a single read result body (Hermes
 * file_read_max_chars default). Applied after line-number formatting so
 * the value that enters context is what we bound.
 */
export const MAX_READ_CHARS = 100_000;
/** Per-line body clamp before gutter (Hermes max_line_length). */
export const MAX_READ_LINE_LENGTH = 2_000;
/**
 * When file size exceeds this and the caller did not pass a narrow limit,
 * attach a hint encouraging targeted reads.
 */
export const LARGE_FILE_HINT_BYTES = 512 * 1024;
export const MAX_WRITE_BYTES = 2 * 1024 * 1024;
/**
 * Soft guidance for model-authored writes (still hard-capped by MAX_WRITE_BYTES).
 * Hermes discourages dumping multi-MB blobs via the write tool.
 */
export const WRITE_CONTENT_SOFT_WARN_BYTES = 256 * 1024;
export const MAX_BASH_COMMAND_LEN = 8_192;
export const MAX_BASH_TIMEOUT_SEC = 600;
export const DEFAULT_BASH_TIMEOUT_SEC = 120;
/**
 * Hermes/Pi terminal output budget (~50KB / 2000 lines per stream).
 * Applied independently to stdout and stderr; the JSON envelope uses a
 * larger cap so dual-stream results do not collapse into result_bytes.
 */
export const MAX_EXEC_STREAM_BYTES = 50 * 1024;
export const MAX_EXEC_STREAM_LINES = 2_000;
/** Envelope for bash/python tool JSON (both streams + metadata). */
export const MAX_EXEC_RESULT_BYTES = 110 * 1024;
export const MAX_PYTHON_CODE_BYTES = 256 * 1024;
export const MAX_PYTHON_ARGS = 32;
export const MAX_PYTHON_TIMEOUT_SEC = 600;
export const DEFAULT_PYTHON_TIMEOUT_SEC = 120;
export const MAX_PROCESS_TIMEOUT_SEC = 14_400;
export const DEFAULT_PROCESS_TIMEOUT_SEC = 3_600;
/** process_read default/max chunk size (characters of stream data). */
export const DEFAULT_PROCESS_READ_LIMIT = 8_192;
export const MAX_PROCESS_READ_LIMIT = 65_536;
export const MAX_ENV_KEYS = 32;
export const MAX_ENV_KEY_LEN = 64;
export const MAX_ENV_VALUE_LEN = 1_024;
export const MAX_PATH_LEN = 512;
export const MAX_PROCESS_ID_LEN = 64;
export const MAX_CURSOR_LEN = 64;

/** Logical workspace root (plan). Never a host physical path. */
export const LOGICAL_WORKSPACE_ROOT = '/home/sandbox/workspace';
export const LOGICAL_SKILL_ROOT = '/home/sandbox/skill';
/** Per-session sandbox temporary directory. Read-only through the file tool. */
export const LOGICAL_TEMP_ROOT = '/tmp';

export const PROCESS_SIGNALS = Object.freeze(['TERM', 'KILL', 'INT']);

/** Env keys forbidden in bash/process (host secret leakage). */
export const SENSITIVE_ENV_KEY =
  /^(?:AWS_|AZURE_|GCP_|GOOGLE_|OPENAI_|ANTHROPIC_|API[_-]?KEY|SECRET|PASSWORD|TOKEN|AUTHORIZATION|BEARER|PRIVATE[_-]?KEY|SSH_|HOME|PATH|LD_|DYLD_)/i;
