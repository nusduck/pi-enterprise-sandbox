/**
 * SkillManager — install / edit / uninstall / reload over the two-tier skill
 * tree, scoped to one caller.
 *
 * Reads see the union of the bundled system tier and the caller's own
 * `<orgId>/<userId>` directory, system first. Writes only ever land in that one
 * directory, so a manager built for user A can never touch user B's skills —
 * that per-user scoping is what makes installs safe to allow in every
 * environment instead of behind a deployment-wide mode flag.
 */
import {
  DEFAULT_SKILL_ROOTS,
  SYSTEM_SKILL_ROOT,
  USER_SKILL_ROOT,
  normalizeSkillRoots,
  primarySkillRoot,
  skillRootsForIdentity,
  userSkillRootFor,
  writableSkillRoot,
  isUnderSkillRoot,
} from './paths.js';
import {
  installSkill,
  uninstallSkill,
  editSkillFile,
  listInstalledSkills,
  describeInstalledSkills,
} from './install.js';
import fs from 'node:fs';
import path from 'node:path';

import { emitSkillAudit } from './audit.js';

/**
 * Skill modes.
 *
 * `enabled` (default) lets a user install into their own per-user directory in
 * any environment, production included. That is safe without a deployment-wide
 * flag for two reasons: the directory is scoped to `<orgId>/<userId>` so an
 * install can never enter another user's agent context, and `skill_install`
 * carries `high` risk in the tool-risk table, so it goes through approval.
 *
 * `readonly` is the kill switch for deployments that want no skill
 * installation at all; the skill-lifecycle tools are then not registered.
 *
 * `development` is a legacy alias for `enabled`, kept so existing `.env` files
 * and compose overlays keep working.
 */
export const SKILLS_MODE = Object.freeze({
  READONLY: 'readonly',
  ENABLED: 'enabled',
  /** @deprecated alias for ENABLED */
  DEVELOPMENT: 'enabled',
});

/**
 * Resolve SKILLS_MODE from env-like object.
 * @param {NodeJS.ProcessEnv | Record<string, string|undefined>} [env]
 * @returns {'readonly' | 'enabled'}
 */
export function resolveSkillsMode(env = process.env) {
  const raw = env?.SKILLS_MODE;
  if (raw == null || String(raw).trim() === '') return SKILLS_MODE.ENABLED;
  const v = String(raw).trim().toLowerCase();
  // `production`/`prod` keep meaning the locked-down thing: an operator who
  // wrote that word wants installs off, not on.
  if (
    v === 'readonly' ||
    v === 'ro' ||
    v === 'off' ||
    v === 'disabled' ||
    v === 'production' ||
    v === 'prod'
  ) {
    return SKILLS_MODE.READONLY;
  }
  if (v === 'enabled' || v === 'on' || v === 'development' || v === 'dev') {
    return SKILLS_MODE.ENABLED;
  }
  // Unknown values fail closed to readonly.
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
 * The two configured *mount* roots: system tier, and the base of the per-user
 * tier. `SKILLS_ROOT` / `SKILLS_USER_ROOT` relocate them independently, so the
 * two can never collapse into one.
 *
 * @param {NodeJS.ProcessEnv | Record<string, string|undefined>} [env]
 * @returns {{ systemRoot: string, userRootBase: string }}
 */
export function resolveSkillMountRoots(env = process.env) {
  const system = String(
    env?.SKILLS_ROOT || env?.AGENT_SKILLS_ROOT || SYSTEM_SKILL_ROOT,
  ).trim();
  const userBase = String(
    env?.SKILLS_USER_ROOT || env?.AGENT_SKILLS_USER_ROOT || USER_SKILL_ROOT,
  ).trim();
  return {
    systemRoot: system || SYSTEM_SKILL_ROOT,
    userRootBase: userBase || USER_SKILL_ROOT,
  };
}

/**
 * Skill roots for one caller, in read-precedence order.
 *
 * With an identity: `[systemRoot, <userBase>/<orgId>/<userId>]`.
 * Without one (operator diagnostics, tests): the mount roots, so inventory
 * tooling can still see the tree without impersonating a user.
 *
 * @param {NodeJS.ProcessEnv | Record<string, string|undefined>} [env]
 * @param {{ orgId?: unknown, userId?: unknown } | null} [identity]
 */
export function resolveSkillRoots(env = process.env, identity = null) {
  const { systemRoot, userRootBase } = resolveSkillMountRoots(env);
  if (identity?.orgId != null && identity?.userId != null) {
    return skillRootsForIdentity(identity, { systemRoot, userRootBase });
  }
  return normalizeSkillRoots([systemRoot, userRootBase]);
}

/**
 * @param {{
 *   mode?: 'readonly' | 'enabled',
 *   identity?: { orgId: unknown, userId: unknown } | null,
 *   skillRoots?: string[],
 *   userSkillRoot?: string | null,
 *   localAllowlist?: string[],
 *   auditLogPath?: string | null,
 *   auditSink?: ((ev: object) => void) | null,
 *   getMeta?: () => object,
 *   getAgentSession?: () => { reload?: () => Promise<void>, resourceLoader?: { getSkills?: () => { skills: unknown[] }, reload?: () => Promise<void> } } | null,
 *   onAfterReload?: () => Promise<void>|void,
 * }} [options]
 */
export function createSkillManager(options = {}) {
  const mode = options.mode || resolveSkillsMode();
  const identity = options.identity ?? null;
  const skillRoots = normalizeSkillRoots(
    options.skillRoots || resolveSkillRoots(process.env, identity),
  );
  const skillRoot = primarySkillRoot(skillRoots);
  const userRoot = options.userSkillRoot
    ? normalizeSkillRoots([options.userSkillRoot])[0]
    : writableSkillRoot(skillRoots);
  const localAllowlist = options.localAllowlist || resolveLocalAllowlist();
  const auditLogPath = options.auditLogPath ?? process.env.SKILLS_AUDIT_LOG ?? null;
  const auditSink = options.auditSink || null;
  const getMeta = typeof options.getMeta === 'function' ? options.getMeta : () => ({});
  const getAgentSession =
    typeof options.getAgentSession === 'function' ? options.getAgentSession : () => null;
  const onAfterReload =
    typeof options.onAfterReload === 'function' ? options.onAfterReload : null;
  // Durable authority for user skills. Optional so single-node development and
  // the existing tests keep working against the filesystem alone; when present
  // the local directory becomes a rebuildable cache instead of the only copy.
  const bundleStore = options.bundleStore ?? null;
  const bundleScope =
    identity?.orgId && identity?.userId
      ? { orgId: identity.orgId, userId: identity.userId }
      : null;

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

  function assertWritable(action) {
    if (mode !== SKILLS_MODE.ENABLED) {
      const err = new Error(
        `Skill ${action} denied: SKILLS_MODE=${mode} disables skill installation`,
      );
      audit({ action, result: 'denied', error: err.message });
      throw err;
    }
    if (!userRoot) {
      const err = new Error(
        `Skill ${action} denied: no per-user skill directory resolved ` +
          '(needs orgId + userId, and a read-write SKILLS_USER_ROOT mount)',
      );
      audit({ action, result: 'denied', error: err.message });
      throw err;
    }
    // The per-user directory is created on first write, not at startup: there
    // is no list of users to pre-create it for.
    fs.mkdirSync(userRoot, { recursive: true });
  }

  /** Names the bundled system tier owns; an install must not shadow them. */
  function systemSkillNames() {
    const names = new Set();
    for (const root of skillRoots) {
      if (userRoot && root === userRoot) continue;
      for (const name of listInstalledSkills(root)) names.add(name);
    }
    return names;
  }

  /** Copy a freshly installed skill into the durable store. */
  async function persistBundle(skillName, source) {
    if (!bundleStore || !bundleScope || !userRoot) return;
    try {
      const { packSkillBundle } = await import('./bundle-store.js');
      const packed = await packSkillBundle(path.join(userRoot, skillName));
      await bundleStore.put(bundleScope, skillName, { ...packed, source });
    } catch (err) {
      audit({
        action: 'install',
        result: 'partial',
        skill_name: skillName,
        error: `durable store write failed: ${err?.message || String(err)}`,
      });
    }
  }

  /** Drop a skill from the durable store so other pods stop materialising it. */
  async function forgetBundle(skillName) {
    if (!bundleStore || !bundleScope) return;
    try {
      await bundleStore.remove(bundleScope, skillName);
    } catch (err) {
      // The local copy is gone; leaving the row means other pods keep it until
      // the next successful uninstall. Visible, not silent.
      audit({
        action: 'uninstall',
        result: 'partial',
        skill_name: skillName,
        error: `durable store delete failed: ${err?.message || String(err)}`,
      });
    }
  }

  return {
    mode,
    skillRoot,
    skillRoots,
    userSkillRoot: userRoot,
    localAllowlist,
    identity,
    isEnabled: () => mode === SKILLS_MODE.ENABLED,
    isUnderSkillRoot: (p) => isUnderSkillRoot(p, skillRoots),
    /** Names only, across both tiers (system shadows user). */
    listInstalled: () =>
      describeInstalledSkills(skillRoots, { writableRoot: userRoot }).map(
        (s) => s.name,
      ),
    /** Full records with tier + description, for the skill_list tool. */
    describeInstalled: () =>
      describeInstalledSkills(skillRoots, { writableRoot: userRoot }),

    /**
     * `sourceType`, `name`, `ref` and `subpath` are optional — see installSkill.
     * @param {{ name?: string, sourceType?: string, source: string, ref?: string, subpath?: string }} params
     */
    async install(params) {
      assertWritable('install');
      try {
        const result = await installSkill({
          name: params.name,
          sourceType: params.sourceType,
          source: params.source,
          ref: params.ref,
          subpath: params.subpath,
          skillRoot: userRoot,
          localAllowlist,
          systemSkillNames: systemSkillNames(),
        });
        // Persist after the filesystem swap, not before: the installed
        // directory is what we bundle, so a failed install stores nothing.
        // A store failure is reported but does not undo the install — the
        // skill works on this pod, it just is not durable yet.
        await persistBundle(result.name, {
          sourceType: result.source_type,
          source: result.source,
          resolvedCommit: result.resolved_commit,
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
     * @param {{ name: string }} params
     */
    async uninstall(params) {
      assertWritable('uninstall');
      try {
        const result = await uninstallSkill({
          name: params.name,
          skillRoot: userRoot,
        });
        await forgetBundle(result.name);
        audit({
          action: 'uninstall',
          result: 'success',
          skill_name: result.name,
          summary: result.summary,
        });
        return result;
      } catch (err) {
        audit({
          action: 'uninstall',
          result: 'failure',
          skill_name: params?.name,
          error: err?.message || String(err),
        });
        throw err;
      }
    },

    /**
     * @param {{ path: string, content: string }} params
     */
    async edit(params) {
      assertWritable('edit');
      try {
        const result = await editSkillFile({
          skillRoot: userRoot,
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
        // Fail-closed: session.reload()/resourceLoader.reload() rebuild the
        // extension runtime in place without going through PiRuntimeFactory's
        // bind path, so re-run the same fail-closed assertion here. If the
        // enterprise-policy (or any other) extension factory errored during
        // this reload, surface it as a failure instead of reporting success.
        if (session?.resourceLoader) {
          // Imported lazily: pi-runtime-factory reads config.js, which reads
          // this module, and a static edge would leave SKILLS_MODE in TDZ for
          // anything that loads config.js first.
          const { assertExtensionsLoadedClean } = await import(
            '../infrastructure/pi/pi-runtime-factory.js'
          );
          assertExtensionsLoadedClean({ resourceLoader: session.resourceLoader }, session);
        }
        const skills =
          session?.resourceLoader?.getSkills?.()?.skills ||
          session?.getSkills?.()?.skills ||
          null;
        if (Array.isArray(skills)) skillCount = skills.length;
        const installed = describeInstalledSkills(skillRoots, {
          writableRoot: userRoot,
        }).map((s) => s.name);
        if (onAfterReload) {
          try {
            await onAfterReload();
          } catch (reloadErr) {
            console.warn(
              '[skills] onAfterReload failed:',
              reloadErr?.message || reloadErr,
            );
          }
        }
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

export {
  DEFAULT_SKILL_ROOTS,
  SYSTEM_SKILL_ROOT,
  USER_SKILL_ROOT,
  skillRootsForIdentity,
  userSkillRootFor,
};
