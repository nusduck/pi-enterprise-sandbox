/**
 * Shared configuration for the Agent service.
 * All environment variable reads are centralized here.
 */
import {
  resolveSkillsMode,
  resolveLocalAllowlist,
  resolveSkillRoots,
  SKILLS_MODE,
} from './skills/manager.js';
import { primarySkillRoot, DEFAULT_SKILL_ROOTS } from './skills/paths.js';

/**
 * Whether interactive approval is required for high-risk tools.
 * Default true. When false, approval_required tools execute with bypass audit;
 * hard_deny is never overridden. Aligns with SANDBOX_APPROVAL_ENABLED when unset.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveApprovalEnabled(env = process.env) {
  if (env.APPROVAL_ENABLED != null && String(env.APPROVAL_ENABLED).trim() !== '') {
    return String(env.APPROVAL_ENABLED).toLowerCase() !== 'false';
  }
  if (env.SANDBOX_APPROVAL_ENABLED != null && String(env.SANDBOX_APPROVAL_ENABLED).trim() !== '') {
    return String(env.SANDBOX_APPROVAL_ENABLED).toLowerCase() !== 'false';
  }
  return true;
}

export { resolveSkillsMode, SKILLS_MODE, resolveLocalAllowlist, resolveSkillRoots };

const skillRoots = resolveSkillRoots();

export const config = {
  PORT: parseInt(process.env.PORT, 10) || 4100,
  SANDBOX_BASE_URL: process.env.SANDBOX_BASE_URL || 'http://sandbox:8081',
  SANDBOX_API_TOKEN: process.env.SANDBOX_API_TOKEN || '',
  /**
   * Shared secret for BFF → Agent internal API.
   * Empty allows open dev mode (same host only recommended).
   */
  AGENT_INTERNAL_TOKEN: process.env.AGENT_INTERNAL_TOKEN || '',
  LLMIO_BASE_URL: process.env.LLMIO_BASE_URL || '',
  LLMIO_API_KEY: process.env.LLMIO_API_KEY || '',
  MODEL_ID: process.env.MODEL_ID || 'deepseek-v4-flash',
  NODE_ENV: process.env.NODE_ENV || 'development',
  APPROVAL_ENABLED: resolveApprovalEnabled(),
  /**
   * Skill management mode.
   * - readonly (default): production-safe; skill_install/edit absent; skill tree R/O policy
   * - development: dedicated skill_install / skill_edit / skill_reload tools enabled
   * Requires a writable skills volume mount when development (see AGENT_SKILLS_MOUNT).
   */
  SKILLS_MODE: resolveSkillsMode(),
  /** Primary skill root on the agent (shared volume). */
  SKILLS_ROOT: primarySkillRoot(skillRoots),
  SKILL_ROOTS: skillRoots,
  /** Comma-separated allowlisted absolute dirs for local skill_install sources. */
  SKILLS_INSTALL_LOCAL_ALLOWLIST: resolveLocalAllowlist(),
  /** Optional file path for skill change audit lines (also always console). */
  SKILLS_AUDIT_LOG: process.env.SKILLS_AUDIT_LOG || '',
  DEFAULT_SKILL_ROOTS,
};

export const AUTH_HEADER = config.SANDBOX_API_TOKEN
  ? { 'X-API-Key': config.SANDBOX_API_TOKEN }
  : {};
