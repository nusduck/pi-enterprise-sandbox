/**
 * Dedicated skill management tools (development mode only).
 * skill_install, skill_edit, skill_reload
 */
import { Type } from 'typebox';
import { createSkillManager, SKILLS_MODE } from './manager.js';

/**
 * @param {{
 *   manager?: ReturnType<typeof createSkillManager>,
 *   mode?: string,
 *   getAgentSession?: () => object | null,
 *   getMeta?: () => object,
 *   skillRoots?: string[],
 *   localAllowlist?: string[],
 *   auditLogPath?: string | null,
 *   auditSink?: ((ev: object) => void) | null,
 * }} [ctx]
 * @returns {object[]} tool defs (empty when not development)
 */
export function createSkillTools(ctx = {}) {
  const manager =
    ctx.manager ||
    createSkillManager({
      mode: ctx.mode,
      skillRoots: ctx.skillRoots,
      localAllowlist: ctx.localAllowlist,
      auditLogPath: ctx.auditLogPath,
      auditSink: ctx.auditSink,
      getMeta: ctx.getMeta,
      getAgentSession: ctx.getAgentSession,
    });

  if (!manager.isDevelopment()) {
    return [];
  }

  const installTool = {
    name: 'skill_install',
    label: 'Install Skill',
    description:
      'Install a shared skill into the skill root (development mode only). ' +
      'Sources: allowlisted local directory, or HTTPS Git URL with required ref. ' +
      'Records resolved commit for git installs. Atomic replace; failure does not corrupt existing skills. ' +
      'Rejected: git@/SSH, credentials in URL, npm/OCI, arbitrary scripts/tarballs. ' +
      'Call skill_reload (or start a new turn) after install for the loader to pick up changes.',
    parameters: Type.Object({
      name: Type.String({
        description: 'Skill package name (lowercase slug, must match SKILL.md name)',
      }),
      source_type: Type.String({
        description: 'local | git',
      }),
      source: Type.String({
        description:
          'Local absolute path under allowlist, or HTTPS Git URL (no credentials)',
      }),
      ref: Type.Optional(
        Type.String({
          description: 'Required for git: branch, tag, or commit SHA',
        }),
      ),
      subpath: Type.Optional(
        Type.String({
          description: 'Optional subdirectory inside the git repo that contains SKILL.md',
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      try {
        const result = await manager.install({
          name: params.name,
          sourceType: params.source_type,
          source: params.source,
          ref: params.ref,
          subpath: params.subpath,
        });
        return {
          content: [
            {
              type: 'text',
              text:
                `Installed skill "${result.name}" at ${result.path}\n` +
                `source_type=${result.source_type}` +
                (result.resolved_commit
                  ? ` resolved_commit=${result.resolved_commit}`
                  : '') +
                `\n${result.summary}\n` +
                'Call skill_reload or continue in the next turn to load it.',
            },
          ],
          details: result,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `skill_install failed: ${err.message}` }],
          details: { isError: true },
          isError: true,
        };
      }
    },
  };

  const editTool = {
    name: 'skill_edit',
    label: 'Edit Skill File',
    description:
      'Write/replace a file under the shared skill root (development mode only). ' +
      'Path must stay under the skill root; SKILL.md content is validated. ' +
      'Do not use generic write/edit/bash for skill files — they are blocked. ' +
      'Call skill_reload after structural changes.',
    parameters: Type.Object({
      path: Type.String({
        description:
          'Path relative to skill root or absolute under /home/sandbox/skill/...',
      }),
      content: Type.String({ description: 'Full file content to write' }),
    }),
    execute: async (_toolCallId, params) => {
      try {
        const result = await manager.edit({
          path: params.path,
          content: params.content,
        });
        return {
          content: [
            {
              type: 'text',
              text: `Updated skill file ${result.path} (${result.bytes} bytes)`,
            },
          ],
          details: result,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `skill_edit failed: ${err.message}` }],
          details: { isError: true },
          isError: true,
        };
      }
    },
  };

  const reloadTool = {
    name: 'skill_reload',
    label: 'Reload Skills',
    description:
      'Reload the skill loader so newly installed/edited skills are visible. ' +
      'If a live session reload is unavailable, the next agent turn will pick up changes.',
    parameters: Type.Object({}),
    execute: async () => {
      try {
        const result = await manager.reload();
        return {
          content: [{ type: 'text', text: result.summary }],
          details: result,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `skill_reload failed: ${err.message}` }],
          details: { isError: true },
          isError: true,
        };
      }
    },
  };

  return [installTool, editTool, reloadTool];
}

/**
 * Tool names for allowlist when development mode is on.
 */
export const SKILL_TOOL_NAMES = ['skill_install', 'skill_edit', 'skill_reload'];

/**
 * Hard-deny stubs when tools must exist in catalog but mode is readonly
 * (prefer omitting tools entirely — use only if allowlist is static).
 */
export function createReadonlySkillToolStubs() {
  const deny = (name) => ({
    name,
    label: name,
    description: `Denied: SKILLS_MODE=readonly (skill management disabled)`,
    parameters: Type.Object({}),
    execute: async () => ({
      content: [
        {
          type: 'text',
          text: `Blocked: ${name} is unavailable when SKILLS_MODE=readonly`,
        },
      ],
      details: { isError: true },
      isError: true,
    }),
  });
  return SKILL_TOOL_NAMES.map(deny);
}

export { SKILLS_MODE };
