/**
 * DSH 运行时与工具面共享常量。
 */
export const PINNED_DSH_VERSION = '0.1.1-rc.2';

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
