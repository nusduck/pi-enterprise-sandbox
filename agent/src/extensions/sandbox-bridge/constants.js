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

/** Tools that must run sequentially. */
export const SEQUENTIAL_TOOLS = Object.freeze(
  new Set([
    'write',
    'edit',
    'bash',
    'python',
    'process_start',
    'process_kill',
    'submit_artifact',
  ]),
);

export const DEFAULT_READ_LIMIT = 20_000;
export const MAX_READ_LIMIT = 50_000;
export const MAX_READ_BYTES = 256 * 1024;
export const MAX_WRITE_BYTES = 2 * 1024 * 1024;
export const MAX_BASH_COMMAND_LEN = 8_192;
export const MAX_BASH_TIMEOUT_SEC = 600;
export const DEFAULT_BASH_TIMEOUT_SEC = 120;
export const MAX_PYTHON_CODE_BYTES = 256 * 1024;
export const MAX_PYTHON_ARGS = 32;
export const MAX_PYTHON_TIMEOUT_SEC = 600;
export const DEFAULT_PYTHON_TIMEOUT_SEC = 120;
export const MAX_PROCESS_TIMEOUT_SEC = 14_400;
export const DEFAULT_PROCESS_TIMEOUT_SEC = 3_600;
export const MAX_ENV_KEYS = 32;
export const MAX_ENV_KEY_LEN = 64;
export const MAX_ENV_VALUE_LEN = 1_024;
export const MAX_PATH_LEN = 512;
export const MAX_ARTIFACT_DESC_LEN = 1_024;
export const MAX_PROCESS_ID_LEN = 64;
export const MAX_CURSOR_LEN = 64;
export const MAX_STDOUT_CAPTURE = 64 * 1024;

/** Logical workspace root (plan). Never a host physical path. */
export const LOGICAL_WORKSPACE_ROOT = '/home/sandbox/workspace';
export const LOGICAL_SKILL_ROOT = '/home/sandbox/skill';

export const PROCESS_SIGNALS = Object.freeze(['TERM', 'KILL', 'INT']);

/** Env keys forbidden in bash/process (host secret leakage). */
export const SENSITIVE_ENV_KEY =
  /^(?:AWS_|AZURE_|GCP_|GOOGLE_|OPENAI_|ANTHROPIC_|API[_-]?KEY|SECRET|PASSWORD|TOKEN|AUTHORIZATION|BEARER|PRIVATE[_-]?KEY|SSH_|HOME|PATH|LD_|DYLD_)/i;
