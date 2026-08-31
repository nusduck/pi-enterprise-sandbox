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

/**
 * 工具名的事实源在 `src/runtime/policy/tool-names.ts`（ADR 0009 D4）。
 * 这里只做转出，保住既有 import 路径不变。**不要在本文件里再列一份工具名。**
 */
export {
  SANDBOX_TOOL_NAMES,
  ASK_USER_TOOL_NAME,
  ENTERPRISE_DEFAULT_TOOLS,
  LEGACY_TOOL_NAME_ALIASES,
  RETIRED_TOOL_REASON_CODE,
  resolveToolNameAlias,
  isRetiredToolName,
} from '../../runtime/policy/tool-names.js';

export const REQUIRED_EXTENSION_NAMES = Object.freeze([]);
export const REGISTERED_EXTENSION_NAMES = Object.freeze([]);
