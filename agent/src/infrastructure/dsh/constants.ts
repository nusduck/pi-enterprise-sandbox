/**
 * DSH 运行时与工具面共享常量。
 */
export const PINNED_DSH_VERSION = '0.1.1-rc.2';
/** MySQL snapshot/journal 列仍叫 pi_sdk_version，存的是会话格式钉。 */
export const PINNED_PI_SDK_VERSION = '0.80.3';

export const LOGICAL_WORKSPACE_ROOT = '/home/sandbox/workspace';
export const LOGICAL_SKILL_ROOT = '/home/sandbox/skill';
export const LOGICAL_SKILL_ROOTS = Object.freeze([
  LOGICAL_SKILL_ROOT,
  '/home/sandbox/skill-user',
]);

export const SANDBOX_TOOL_NAMES = Object.freeze([
  'read', 'ls', 'find', 'grep', 'write', 'edit', 'bash', 'python',
  'process_start', 'process_status', 'process_read', 'process_kill',
  'submit_artifact',
]);

export const ENTERPRISE_DEFAULT_TOOLS = SANDBOX_TOOL_NAMES;

export const REQUIRED_EXTENSION_NAMES = Object.freeze([]);
export const REGISTERED_EXTENSION_NAMES = Object.freeze([]);
