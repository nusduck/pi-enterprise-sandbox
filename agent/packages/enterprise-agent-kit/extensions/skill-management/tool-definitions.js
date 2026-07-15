/**
 * Dedicated skill management tools (development mode only).
 * skill_install, skill_edit, skill_reload
 *
 * When a sandbox client is provided, executions are recorded in the Tool Ledger
 * (ADR §4.4) with the same prepare → executing → terminal lifecycle.
 */
import { Type } from 'typebox';
import { createHash, randomUUID } from 'node:crypto';
import { createSkillManager, SKILLS_MODE } from '../../../../skills/manager.js';
import { summarizeToolArguments } from '../../../../runtime/tool-payload-sanitizer.js';

const LEDGER_TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'unknown']);

/**
 * @param {{
 *   manager?: ReturnType<typeof createSkillManager>,
 *   mode?: string,
 *   getAgentSession?: () => object | null,
 *   getMeta?: () => object,
 *   client?: object | null,
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

  const sb = ctx.client || null;
  const getMeta = typeof ctx.getMeta === 'function' ? ctx.getMeta : () => ({});

  /**
   * Ledger wrap for skill tools (best-effort; fail-open if client missing).
   * @param {string} toolName
   * @param {Function} executeFn
   */
  function withSkillLedger(toolName, executeFn) {
    return async (toolCallId, params, ...rest) => {
      if (!sb || typeof sb.prepareToolExecution !== 'function') {
        return executeFn(toolCallId, params, ...rest);
      }
      const meta = getMeta() || {};
      const callId =
        toolCallId || `tc_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      const ledgerParams = summarizeToolArguments(toolName, params);
      const basis = JSON.stringify({
        tool: toolName,
        run_id: meta.run_id || null,
        params: ledgerParams,
      });
      const idem =
        `tc_${callId}` ||
        `idem_${toolName}_${createHash('sha256').update(basis).digest('hex').slice(0, 24)}`;
      let active = false;
      try {
        const prepared = await sb.prepareToolExecution({
          tool_call_id: callId,
          run_id: meta.run_id || 'run_unknown',
          idempotency_key: idem,
          tool_name: toolName,
          // Full content stays in the in-process executeFn call. The durable
          // ledger only needs enough metadata for recovery and auditing.
          arguments: ledgerParams,
          session_id: meta.session_id || null,
          conversation_id: meta.conversation_id || null,
          workspace_id: meta.workspace_id || meta.workspace_key || null,
          summary: toolName,
        });
        active = true;
        if (prepared && LEDGER_TERMINAL.has(prepared.status)) {
          const cached = prepared.result_json;
          if (cached && Array.isArray(cached.content)) {
            return {
              content: cached.content,
              details: { ...(cached.details || {}), ledger_replay: true },
              isError: Boolean(cached.isError),
            };
          }
          return {
            content: [
              {
                type: 'text',
                text:
                  prepared.result_summary ||
                  prepared.summary ||
                  `already ${prepared.status}`,
              },
            ],
            details: { ledger_replay: true, status: prepared.status },
            isError: prepared.status === 'failed',
          };
        }
        if (prepared?.status === 'executing') {
          return {
            content: [
              {
                type: 'text',
                text: `Tool call ${callId} already executing; refusing duplicate`,
              },
            ],
            details: { isError: true, idempotent_block: true },
            isError: true,
          };
        }
      } catch {
        active = false;
      }

      if (active && typeof sb.markToolExecuting === 'function') {
        try {
          await sb.markToolExecuting(callId);
        } catch {
          /* ignore */
        }
      }

      let result;
      try {
        result = await executeFn(callId, params, ...rest);
      } catch (err) {
        result = {
          content: [{ type: 'text', text: `${toolName} failed: ${err.message}` }],
          details: { isError: true },
          isError: true,
        };
      }

      if (active && typeof sb.markToolTerminal === 'function') {
        const isErr = Boolean(result?.isError);
        const summary = Array.isArray(result?.content)
          ? result.content
              .filter((c) => c?.type === 'text')
              .map((c) => c.text)
              .join('\n')
              .slice(0, 2000)
          : toolName;
        try {
          await sb.markToolTerminal(callId, {
            status: isErr ? 'failed' : 'succeeded',
            summary,
            error: isErr ? summary : null,
            result_json: {
              content: result?.content || [],
              details: result?.details || {},
              isError: isErr,
            },
          });
        } catch (err) {
          // A lost terminal response must not leave the UI in Running. If
          // the intended status cannot be written, record unknown so a later
          // reconciliation cannot incorrectly replay the side effect.
          try {
            await sb.markToolTerminal(callId, {
              status: 'unknown',
              summary: `${summary}; terminal outcome could not be confirmed`,
              error: err?.message || String(err),
            });
          } catch {
            /* Run-boundary reconciliation remains the final safety net. */
          }
        }
      }
      return result;
    };
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
    execute: withSkillLedger('skill_install', async (_toolCallId, params) => {
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
    }),
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
    execute: withSkillLedger('skill_edit', async (_toolCallId, params) => {
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
    }),
  };

  const reloadTool = {
    name: 'skill_reload',
    label: 'Reload Skills',
    description:
      'Reload the skill loader so newly installed/edited skills are visible. ' +
      'If a live session reload is unavailable, the next agent turn will pick up changes.',
    parameters: Type.Object({}),
    execute: withSkillLedger('skill_reload', async () => {
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
    }),
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
