/**
 * Stable sandbox tool names + allowlist helpers.
 *
 * Kept outside the deleted process-local Run/agent-runtime stack so enterprise-agent-kit
 * tests and profile tooling can share one contract without importing Run Manager.
 */

import { config, SKILLS_MODE } from '../config.js';
import { SKILL_TOOL_NAMES } from '../packages/enterprise-agent-kit/extensions/skill-management/tool-definitions.js';

/** Stable Sandbox tool names exposed through the active Agent Profile. */
export const BASE_TOOL_NAMES = Object.freeze([
  'read',
  'write',
  'edit',
  'apply_patch',
  'bash',
  'run_python',
  'run_node',
  'ls',
  'find',
  'grep',
  'submit_artifact',
  'process_start',
  'process_status',
  'process_logs',
  'process_wait',
  'process_write_stdin',
  'process_signal',
  'process_cancel',
]);

export const TOOL_REGISTRY_VERSION = '2026-07-14.extension-profile.1';

/**
 * Tool allowlist — skill tools only in development.
 * @param {string} [skillsMode]
 * @param {string[]} [extraNames]
 */
export function resolveToolAllowlist(skillsMode = config.SKILLS_MODE, extraNames = []) {
  const base =
    skillsMode === SKILLS_MODE.DEVELOPMENT
      ? [...BASE_TOOL_NAMES, ...SKILL_TOOL_NAMES]
      : [...BASE_TOOL_NAMES];
  if (Array.isArray(extraNames) && extraNames.length) {
    for (const n of extraNames) {
      if (n && !base.includes(n)) base.push(n);
    }
  }
  return base;
}
