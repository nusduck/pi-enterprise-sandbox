/**
 * SkillManager — mode-gated install / edit / reload API.
 */
import {
  DEFAULT_SKILL_ROOTS,
  normalizeSkillRoots,
  primarySkillRoot,
  isUnderSkillRoot,
} from './paths.js';
import { installSkill, editSkillFile, listInstalledSkills } from './install.js';
import { emitSkillAudit } from './audit.js';

export const SKILLS_MODE = Object.freeze({
  READONLY: 'readonly',
  DEVELOPMENT: 'development',
});

/**
 * Resolve SKILLS_MODE from env-like object.
 * @param {NodeJS.ProcessEnv | Record<string, string|undefined>} [env]
 * @returns {'readonly' | 'development'}
 */
export function resolveSkillsMode(env = process.env) {
  const raw = env?.SKILLS_MODE;
  if (raw == null || String(raw).trim() === '') return SKILLS_MODE.READONLY;
  const v = String(raw).trim().toLowerCase();
  if (v === 'development' || v === 'dev') return SKILLS_MODE.DEVELOPMENT;
  if (v === 'readonly' || v === 'ro' || v === 'production' || v === 'prod') {
    return SKILLS_MODE.READONLY;
  }
  // Unknown values fail closed to readonly
  return SKILLS_MODE.READONLY;
}

/**
 * Parse comma-separated local install allowlist.
 * @param {NodeJS.ProcessEnv | Record<string, string|undefined>} [env]
 * @returns {string[]}
 */
export function resolveLocalAllowlist(env = process.env) {
  const raw = env?.SKILLS_INSTALL_LOCAL_ALLOWLIST || '';
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * @param {NodeJS.ProcessEnv | Record<string, string|undefined>} [env]
 */
export function resolveSkillRoots(env = process.env) {
  const raw = env?.SKILLS_ROOT || env?.AGENT_SKILLS_ROOT;
  if (raw && String(raw).trim()) {
    return normalizeSkillRoots([String(raw).trim(), ...DEFAULT_SKILL_ROOTS]);
  }
  return normalizeSkillRoots([...DEFAULT_SKILL_ROOTS]);
}

/**
 * @param {{
 *   mode?: 'readonly' | 'development',
 *   skillRoots?: string[],
 *   localAllowlist?: string[],
 *   auditLogPath?: string | null,
 *   auditSink?: ((ev: object) => void) | null,
 *   getMeta?: () => object,
 *   getAgentSession?: () => { reload?: () => Promise<void>, resourceLoader?: { getSkills?: () => { skills: unknown[] }, reload?: () => Promise<void> } } | null,
 * }} [options]
 */
export function createSkillManager(options = {}) {
  const mode = options.mode || resolveSkillsMode();
  const skillRoots = normalizeSkillRoots(options.skillRoots || resolveSkillRoots());
  const skillRoot = primarySkillRoot(skillRoots);
  const localAllowlist = options.localAllowlist || resolveLocalAllowlist();
  const auditLogPath = options.auditLogPath ?? process.env.SKILLS_AUDIT_LOG ?? null;
  const auditSink = options.auditSink || null;
  const getMeta = typeof options.getMeta === 'function' ? options.getMeta : () => ({});
  const getAgentSession =
    typeof options.getAgentSession === 'function' ? options.getAgentSession : () => null;

  function audit(partial) {
    return emitSkillAudit(
      {
        ...partial,
        meta: {
          ...getMeta(),
          skills_mode: mode,
          ...(partial.meta || {}),
        },
      },
      { auditLogPath, sink: auditSink },
    );
  }

  function assertDevelopment(action) {
    if (mode !== SKILLS_MODE.DEVELOPMENT) {
      const err = new Error(
        `Skill ${action} denied: SKILLS_MODE=${mode} (requires development)`,
      );
      audit({
        action,
        result: 'denied',
        error: err.message,
      });
      throw err;
    }
  }

  return {
    mode,
    skillRoot,
    skillRoots,
    localAllowlist,
    isDevelopment: () => mode === SKILLS_MODE.DEVELOPMENT,
    isUnderSkillRoot: (p) => isUnderSkillRoot(p, skillRoots),
    listInstalled: () => listInstalledSkills(skillRoot),

    /**
     * @param {{ name: string, sourceType: string, source: string, ref?: string, subpath?: string }} params
     */
    async install(params) {
      assertDevelopment('install');
      try {
        const result = await installSkill({
          name: params.name,
          sourceType: params.sourceType,
          source: params.source,
          ref: params.ref,
          subpath: params.subpath,
          skillRoot,
          localAllowlist,
        });
        audit({
          action: 'install',
          result: 'success',
          skill_name: result.name,
          source_type: result.source_type,
          source: result.source,
          ref: result.ref,
          resolved_commit: result.resolved_commit,
          summary: result.summary,
        });
        return result;
      } catch (err) {
        audit({
          action: 'install',
          result: 'failure',
          skill_name: params?.name,
          source_type: params?.sourceType,
          source: params?.source,
          ref: params?.ref,
          error: err?.message || String(err),
        });
        throw err;
      }
    },

    /**
     * @param {{ path: string, content: string }} params
     */
    async edit(params) {
      assertDevelopment('edit');
      try {
        const result = await editSkillFile({
          skillRoot,
          path: params.path,
          content: params.content,
        });
        audit({
          action: 'edit',
          result: 'success',
          skill_name: String(result.path || '').split('/')[0] || null,
          summary: `edited ${result.path} (${result.bytes} bytes)`,
        });
        return result;
      } catch (err) {
        audit({
          action: 'edit',
          result: 'failure',
          error: err?.message || String(err),
          summary: params?.path,
        });
        throw err;
      }
    },

    /**
     * Reload skill loader for the active agent session (if any).
     * Next turn always reloads via DefaultResourceLoader; this is explicit.
     */
    async reload() {
      // reload is allowed in readonly for re-scan, but no-op write; always ok
      try {
        const session = getAgentSession();
        let skillCount = null;
        if (session && typeof session.reload === 'function') {
          await session.reload();
        } else if (session?.resourceLoader && typeof session.resourceLoader.reload === 'function') {
          await session.resourceLoader.reload();
        }
        const skills =
          session?.resourceLoader?.getSkills?.()?.skills ||
          session?.getSkills?.()?.skills ||
          null;
        if (Array.isArray(skills)) skillCount = skills.length;
        const installed = listInstalledSkills(skillRoot);
        const summary =
          skillCount != null
            ? `reloaded loader skills=${skillCount} installed=${installed.length}`
            : `reload marked; installed=${installed.length} (next turn will pick up changes)`;
        audit({
          action: 'reload',
          result: 'success',
          summary,
        });
        return {
          reloaded: Boolean(session),
          installed,
          skill_count: skillCount,
          summary,
        };
      } catch (err) {
        audit({
          action: 'reload',
          result: 'failure',
          error: err?.message || String(err),
        });
        throw err;
      }
    },
  };
}
