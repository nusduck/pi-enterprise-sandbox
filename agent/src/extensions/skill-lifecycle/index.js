/**
 * skill-lifecycle Extension (optional, development only).
 *
 * Registers the skill lifecycle tools the docs have always promised for
 * `SKILLS_MODE=development`: `skill_list`, `skill_install`, `skill_uninstall`,
 * `skill_edit`, `skill_reload`. Until now the library existed but nothing
 * registered it, so the tools were absent from every run.
 *
 * Writes are confined to the user skill root by SkillManager; the bundled
 * system root stays read-only in every mode. Every tool goes through
 * enterprise-policy like any other (`tool_call` is a global Pi event), and the
 * tool-risk table prices them — `skill_install` defaults to `high`, so an
 * install requires approval unless an operator lowers it.
 *
 * The extension refuses to construct outside development mode: a bundle that
 * would silently register non-functional write tools is a worse failure than a
 * missing extension.
 */

import { Type } from 'typebox';

import {
  toolOk,
  toolResultJson,
} from '../sandbox-bridge/result.js';
import { SKILL_LIFECYCLE_TOOL_NAMES } from './constants.js';

export { SKILL_LIFECYCLE_TOOL_NAMES };

/**
 * Pi custom tools must return AgentToolResult: `{ content: [{type:'text',...}] }`.
 * Returning a bare object (e.g. `{ skills: [...] }`) makes the next model turn
 * fail with `content is not iterable`.
 *
 * @param {unknown} value
 * @param {{ maxDetailString?: number }} [opts]
 */
function skillToolResult(value, opts = {}) {
  // Model-facing text uses toolResultJson's 50KB budget. Keep details
  // compact for event projection (redactPayload caps array length).
  return toolOk(toolResultJson(value), value, {
    maxDetailString: opts.maxDetailString ?? 2_048,
  });
}

/**
 * Compact skill records for the model: keep tier/editable so system
 * (bundled `./skills` → SKILLS_ROOT) vs user (`skill-user/<org>/<user>`)
 * stay distinguishable, and bound description length so a large system
 * catalog still fits the tool-result budget.
 *
 * @param {unknown} skills
 * @returns {object[]}
 */
function compactSkillRecords(skills) {
  if (!Array.isArray(skills)) return [];
  return skills.map((raw) => {
    if (!raw || typeof raw !== 'object') {
      return { name: String(raw ?? ''), tier: 'unknown', editable: false };
    }
    const s = /** @type {Record<string, unknown>} */ (raw);
    const tier = s.tier === 'user' ? 'user' : s.tier === 'system' ? 'system' : 'unknown';
    const description =
      typeof s.description === 'string'
        ? s.description.length > 400
          ? `${s.description.slice(0, 400)}…`
          : s.description
        : undefined;
    return {
      name: String(s.name ?? ''),
      tier,
      editable: tier === 'user' || s.editable === true,
      path: s.path != null ? String(s.path) : undefined,
      root: s.root != null ? String(s.root) : undefined,
      ...(description !== undefined ? { description } : {}),
    };
  });
}

/**
 * Two-tier list payload: system (bundled, read-only) + user (installable).
 * @param {{
 *   skills: unknown,
 *   userSkillRoot?: string | null,
 *   skillRoots?: unknown,
 * }} input
 */
function buildSkillListPayload(input) {
  const skills = compactSkillRecords(input.skills);
  const system = skills.filter((s) => s.tier === 'system');
  const user = skills.filter((s) => s.tier === 'user');
  return {
    // Full union, system first (SkillManager already orders that way).
    skills,
    counts: {
      total: skills.length,
      system: system.length,
      user: user.length,
    },
    // Explicit split so the model does not treat system packages as editable.
    system_skills: system,
    user_skills: user,
    user_skill_root: input.userSkillRoot ?? null,
    skill_roots: Array.isArray(input.skillRoots) ? input.skillRoots : [],
    tiers: {
      system:
        'Bundled/read-only skills from SKILLS_ROOT (repo ./skills mounted at /home/sandbox/skill). Cannot install/edit/uninstall.',
      user:
        'Per-user skills under skill-user/<orgId>/<userId>. skill_install / skill_edit / skill_uninstall only affect this tier.',
    },
  };
}

/**
 * @param {unknown} err
 * @param {string} action
 */
function toolError(err, action) {
  const message = err instanceof Error ? err.message : String(err);
  return Object.assign(new Error(`skill_${action} failed: ${message}`), {
    code: 'SKILL_LIFECYCLE_FAILED',
  });
}

/**
 * @param {{
 *   runContext: object,
 *   deps?: {
 *     skillManager?: object | null,
 *   },
 * }} options
 */
export function createSkillLifecycleExtension(options) {
  const runContext = options?.runContext;
  const manager = options?.deps?.skillManager ?? null;

  if (!manager || typeof manager.install !== 'function') {
    throw new Error(
      'SKILL_MANAGER_REQUIRED: skill-lifecycle requires deps.skillManager',
    );
  }
  if (typeof manager.isEnabled === 'function' && !manager.isEnabled()) {
    throw new Error(
      `SKILLS_MODE_REQUIRED: skill-lifecycle needs skill installation enabled (SKILLS_MODE=${manager.mode})`,
    );
  }
  if (!manager.userSkillRoot) {
    throw new Error(
      'SKILL_USER_ROOT_REQUIRED: skill-lifecycle needs a per-user skill directory (orgId + userId)',
    );
  }

  /**
   * @param {import('@earendil-works/pi-coding-agent').ExtensionAPI} pi
   */
  function skillLifecycleExtension(pi) {
    pi.registerTool({
      name: 'skill_list',
      label: 'List skills',
      description:
        'List skill packages in both tiers: system (bundled from ./skills / SKILLS_ROOT, read-only) and user (per-org/user installs, editable). Returns counts plus system_skills and user_skills.',
      promptSnippet:
        'Inspect system (bundled) and user-installed skill packages',
      parameters: Type.Object({}),
      async execute() {
        try {
          const skills = manager.describeInstalled();
          return skillToolResult(
            buildSkillListPayload({
              skills,
              userSkillRoot: manager.userSkillRoot ?? null,
              skillRoots: manager.skillRoots ?? [],
            }),
          );
        } catch (err) {
          throw toolError(err, 'list');
        }
      },
    });

    pi.registerTool({
      name: 'skill_install',
      label: 'Install skill',
      description:
        'Install a skill package into the user skill root from an HTTPS git URL or an allowlisted local directory, then reload so it is usable immediately. ' +
        'Only `source` is required: the source type is inferred, the package directory is discovered inside the tree, and the name comes from the package SKILL.md.',
      promptSnippet: 'Install a skill package from HTTPS git or an allowlisted local path',
      promptGuidelines: [
        'Pass just the source; supply name/ref/subpath only to pin them.',
        'Installing cannot replace a bundled system skill — rename the package instead.',
      ],
      parameters: Type.Object({
        source: Type.String({ minLength: 1, maxLength: 2048 }),
        name: Type.Optional(Type.String({ maxLength: 64 })),
        ref: Type.Optional(Type.String({ maxLength: 256 })),
        subpath: Type.Optional(Type.String({ maxLength: 512 })),
        source_type: Type.Optional(
          Type.Union([Type.Literal('git'), Type.Literal('local')]),
        ),
      }),
      async execute(_toolCallId, input) {
        let result;
        try {
          result = await manager.install({
            source: input.source,
            name: input.name,
            ref: input.ref,
            subpath: input.subpath,
            sourceType: input.source_type,
          });
        } catch (err) {
          throw toolError(err, 'install');
        }
        // A skill the model cannot use this turn is not really installed.
        let reload = null;
        try {
          reload = await manager.reload();
        } catch (err) {
          reload = {
            reloaded: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
        return skillToolResult({ ...result, reload });
      },
    });

    pi.registerTool({
      name: 'skill_uninstall',
      label: 'Uninstall skill',
      description:
        'Remove an installed skill package from the user skill root, then reload. Bundled system skills cannot be uninstalled.',
      promptSnippet: 'Remove a user-installed skill package',
      parameters: Type.Object({
        name: Type.String({ minLength: 1, maxLength: 64 }),
      }),
      async execute(_toolCallId, input) {
        let result;
        try {
          result = await manager.uninstall({ name: input.name });
        } catch (err) {
          throw toolError(err, 'uninstall');
        }
        let reload = null;
        try {
          reload = await manager.reload();
        } catch (err) {
          reload = {
            reloaded: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
        return skillToolResult({ ...result, reload });
      },
    });

    pi.registerTool({
      name: 'skill_edit',
      label: 'Edit skill file',
      description:
        'Create or replace one file inside a user skill package (path is relative to the user skill root, e.g. my-skill/SKILL.md). Bundled system skills are read-only.',
      promptSnippet: 'Write a file inside a user skill package',
      parameters: Type.Object({
        path: Type.String({ minLength: 1, maxLength: 1024 }),
        content: Type.String(),
      }),
      async execute(_toolCallId, input) {
        try {
          return skillToolResult(
            await manager.edit({ path: input.path, content: input.content }),
          );
        } catch (err) {
          throw toolError(err, 'edit');
        }
      },
    });

    pi.registerTool({
      name: 'skill_reload',
      label: 'Reload skills',
      description:
        'Re-scan the skill roots so newly installed or edited packages are visible to the current session.',
      promptSnippet: 'Re-scan skill roots after changing a package',
      parameters: Type.Object({}),
      async execute() {
        try {
          return skillToolResult(await manager.reload());
        } catch (err) {
          throw toolError(err, 'reload');
        }
      },
    });

    void runContext;
  }

  skillLifecycleExtension.extensionName = 'skill-lifecycle';
  skillLifecycleExtension.extensionMetadata = Object.freeze({
    name: 'skill-lifecycle',
    role: 'skill-lifecycle',
    developmentOnly: true,
    failClosed: true,
    toolsRegistered: true,
    tools: SKILL_LIFECYCLE_TOOL_NAMES,
  });
  return skillLifecycleExtension;
}
