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

import { SKILL_LIFECYCLE_TOOL_NAMES } from './constants.js';

export { SKILL_LIFECYCLE_TOOL_NAMES };

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
        'List installed skill packages with their tier (system = bundled and read-only, user = installed and editable).',
      promptSnippet: 'Inspect which skill packages are installed and editable',
      parameters: Type.Object({}),
      async execute() {
        try {
          const skills =
            typeof manager.describeInstalled === 'function'
              ? manager.describeInstalled()
              : manager.listInstalled();
          return {
            skills,
            user_skill_root: manager.userSkillRoot ?? null,
            skill_roots: manager.skillRoots ?? [],
          };
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
        return { ...result, reload };
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
        return { ...result, reload };
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
          return await manager.edit({ path: input.path, content: input.content });
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
          return await manager.reload();
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
