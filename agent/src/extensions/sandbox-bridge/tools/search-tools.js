/**
 * ls / find / grep — the sandbox-routed replacements for the SDK's local
 * filesystem tools.
 *
 * Those three stay permanently excluded from every Pi session because they read
 * the Agent container's filesystem, not the user's workspace. Without a
 * replacement the model could only explore through `bash`, which is sequential,
 * unbudgeted and unstructured. These route to the Sandbox internal plane
 * instead, are read-only, and may fan out alongside `read`.
 *
 * Built as a factory rather than a literal so the run-scoped `invoke` (ledger
 * bind then transport) and `modeFor` stay owned by the tool bundle.
 */

import { Type } from 'typebox';
import {
  FIND_DEFAULT_LIMIT,
  FIND_DEFAULT_MAX_DEPTH,
  FIND_MAX_DEPTH,
  FIND_MAX_LIMIT,
  GREP_DEFAULT_LIMIT,
  GREP_DEFAULT_OUTPUT_MODE,
  GREP_MAX_CONTEXT,
  GREP_MAX_LIMIT,
  GREP_OUTPUT_MODES,
  LS_DEFAULT_DEPTH,
  LS_MAX_DEPTH,
  MAX_PATH_LEN,
  MAX_SEARCH_PATTERN_LEN,
  MAX_SEARCH_QUERY_LEN,
} from '../constants.js';
import { normalizeLogicalPath } from '../path-guards.js';
import { toolErr, toolOk } from '../result.js';
import { formatGrepResult, formatListResult } from './search-format.js';

/** Clamp an optional model-supplied integer into the tool's budget. */
function clampInt(value, fallback, min, max) {
  const n = value == null ? fallback : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * Skill roots are *listable* but not *searchable*.
 *
 * `ls` is allowed on them: without it the model cannot discover which reference
 * or script files a Skill ships unless its SKILL.md happens to say so, which
 * defeats the point of shipping them. `find` and `grep` stay closed — a
 * content search across every installed package pulls in exactly the material
 * progressive disclosure exists to keep out, and the model can always `ls` then
 * `read` the one file it wants.
 *
 * That split is decided here, at the only layer that knows both the path model
 * and which tool is asking; the Sandbox fails a skill path closed for `find`
 * and `grep` regardless (it is handed no skill roots for them).
 *
 * @param {unknown} raw
 * @param {{ allowSkill?: boolean }} [opts]
 * @returns {{ ok: true, path: string } | { ok: false, result: object }}
 */
function normalizeSearchPath(raw, opts = {}) {
  // allowSkillRead so a skill path is *recognised* rather than reported as a
  // generic out-of-workspace path.
  const norm = normalizeLogicalPath(raw ?? '.', { allowSkillRead: true });
  if (!norm.ok) return { ok: false, result: toolErr(norm.code, norm.reason) };
  if (norm.area === 'skill' && opts.allowSkill !== true) {
    return {
      ok: false,
      result: toolErr(
        'PATH_SKILL_SEARCH_UNSUPPORTED',
        'Skill directory contents cannot be searched. Use ls to see what a ' +
          'skill ships, then read the file you want. find and grep cover the ' +
          'workspace and /tmp only.',
      ),
    };
  }
  return { ok: true, path: norm.path };
}

/**
 * @param {{
 *   invoke: (toolCallId: unknown, method: string, toolName: string, params: object) =>
 *     Promise<{ ok: true, data: any } | { ok: false, result: object }>,
 *   modeFor: (name: string) => string,
 * }} deps
 * @returns {object[]}
 */
export function createSearchToolDefinitions({ invoke, modeFor }) {
  return [
    {
      name: 'ls',
      label: 'List directory',
      description:
        `List a workspace, /tmp or skill directory. depth 0 is the directory itself, default ${LS_DEFAULT_DEPTH}, max ${LS_MAX_DEPTH}. Hidden entries are omitted unless includeHidden is true. Results are budgeted and report truncated with a stopReason. Prefer ls over bash ls.`,
      promptSnippet: 'List workspace, temporary or skill directories with bounded depth',
      promptGuidelines: [
        'Start a task by listing the workspace root before guessing file paths.',
        'Increase depth only when a shallow listing was not enough; a deep listing on a large tree is mostly truncated noise.',
        'Use ls on a skill directory to see which reference files and scripts it ships, then read the one you need; find and grep do not reach skill directories.',
      ],
      parameters: Type.Object({
        path: Type.Optional(Type.String({ maxLength: MAX_PATH_LEN })),
        depth: Type.Optional(
          Type.Integer({ minimum: 0, maximum: LS_MAX_DEPTH }),
        ),
        includeHidden: Type.Optional(Type.Boolean()),
      }),
      executionMode: modeFor('ls'),
      // Every parameter is optional for ls, so a bare call must not throw.
      async execute(toolCallId, params = {}) {
        const norm = normalizeSearchPath(params.path, { allowSkill: true });
        if (!norm.ok) return norm.result;
        const normalizedParams = {
          path: norm.path,
          depth: clampInt(params.depth, LS_DEFAULT_DEPTH, 0, LS_MAX_DEPTH),
          includeHidden: params.includeHidden === true,
        };
        const inv = await invoke(toolCallId, 'lsFiles', 'ls', normalizedParams);
        if (!inv.ok) return inv.result;
        return toolOk(formatListResult('ls', inv.data, norm.path));
      },
    },

    {
      name: 'find',
      label: 'Find files',
      description:
        `Find files by glob pattern under a workspace or /tmp directory; the search already recurses into subdirectories, so a bare pattern like "*.ts" matches that filename anywhere in the tree without a "**/" prefix. Default limit ${FIND_DEFAULT_LIMIT}, max ${FIND_MAX_LIMIT}; max depth ${FIND_MAX_DEPTH}. To scope to a subdirectory, pass path, or write a pattern containing "/" (e.g. "src/*.ts") to match against the path relative to path/root instead of just the filename. Optional type filter: file, dir, symlink. Matches paths, not contents — use grep for contents. Prefer find over bash find.`,
      promptSnippet: 'Find workspace files by glob pattern',
      promptGuidelines: [
        'Use find to locate files by name or extension; use grep to locate them by contents.',
        'On truncation, narrow the pattern or search a subdirectory rather than raising the limit blindly.',
      ],
      parameters: Type.Object({
        pattern: Type.String({ minLength: 1, maxLength: MAX_SEARCH_PATTERN_LEN }),
        path: Type.Optional(Type.String({ maxLength: MAX_PATH_LEN })),
        type: Type.Optional(
          Type.Union([
            Type.Literal('file'),
            Type.Literal('dir'),
            Type.Literal('symlink'),
          ]),
        ),
        maxDepth: Type.Optional(
          Type.Integer({ minimum: 0, maximum: FIND_MAX_DEPTH }),
        ),
        limit: Type.Optional(
          Type.Integer({ minimum: 1, maximum: FIND_MAX_LIMIT }),
        ),
      }),
      executionMode: modeFor('find'),
      async execute(toolCallId, params = {}) {
        const norm = normalizeSearchPath(params.path);
        if (!norm.ok) return norm.result;
        const pattern = String(params.pattern ?? '').trim();
        if (!pattern) return toolErr('PATTERN_REQUIRED', 'pattern is required');
        const normalizedParams = {
          path: norm.path,
          pattern,
          type: params.type ?? null,
          maxDepth: clampInt(
            params.maxDepth,
            FIND_DEFAULT_MAX_DEPTH,
            0,
            FIND_MAX_DEPTH,
          ),
          limit: clampInt(params.limit, FIND_DEFAULT_LIMIT, 1, FIND_MAX_LIMIT),
        };
        const inv = await invoke(
          toolCallId,
          'findFiles',
          'find',
          normalizedParams,
        );
        if (!inv.ok) return inv.result;
        return toolOk(formatListResult('find', inv.data, norm.path));
      },
    },

    {
      name: 'grep',
      label: 'Search file contents',
      description:
        `Search file contents under a workspace or /tmp directory. Literal by default; set regex true for a pattern. Optional glob narrows which files are read — a bare pattern like "*.ts" matches the filename anywhere under path (no "**/" prefix needed); a pattern containing "/" (e.g. "src/*.ts") matches against the path relative to path instead. context adds up to ${GREP_MAX_CONTEXT} surrounding lines per match. Default limit ${GREP_DEFAULT_LIMIT}, max ${GREP_MAX_LIMIT}. outputMode: "content" (default, full match text), "files_with_matches" (just the matching paths, one per file — cheapest for an existence check), or "count" (one match count per file, no text). Prefer grep over bash grep or rg.`,
      promptSnippet: 'Search workspace file contents',
      promptGuidelines: [
        'Use grep to find where something is defined or used before reading whole files.',
        'Add a glob to skip files that cannot match; it is cheaper than a larger limit.',
        'Use outputMode "files_with_matches" or "count" instead of the default when you only need to know which/how many files match — it costs far fewer tokens than full match text.',
        'On truncation, make the query more specific rather than re-running it unchanged.',
      ],
      parameters: Type.Object({
        query: Type.String({ minLength: 1, maxLength: MAX_SEARCH_QUERY_LEN }),
        path: Type.Optional(Type.String({ maxLength: MAX_PATH_LEN })),
        glob: Type.Optional(
          Type.String({ maxLength: MAX_SEARCH_PATTERN_LEN }),
        ),
        regex: Type.Optional(Type.Boolean()),
        caseSensitive: Type.Optional(Type.Boolean()),
        context: Type.Optional(
          Type.Integer({ minimum: 0, maximum: GREP_MAX_CONTEXT }),
        ),
        limit: Type.Optional(
          Type.Integer({ minimum: 1, maximum: GREP_MAX_LIMIT }),
        ),
        outputMode: Type.Optional(
          Type.Union(GREP_OUTPUT_MODES.map((m) => Type.Literal(m))),
        ),
      }),
      executionMode: modeFor('grep'),
      async execute(toolCallId, params = {}) {
        const norm = normalizeSearchPath(params.path);
        if (!norm.ok) return norm.result;
        const query = String(params.query ?? '');
        if (!query.trim()) return toolErr('QUERY_REQUIRED', 'query is required');
        const glob = params.glob == null ? null : String(params.glob);
        if (glob !== null && !glob.trim()) {
          return toolErr('GLOB_INVALID', 'glob must not be blank');
        }
        const outputMode = GREP_OUTPUT_MODES.includes(
          /** @type {any} */ (params.outputMode),
        )
          ? params.outputMode
          : GREP_DEFAULT_OUTPUT_MODE;
        const normalizedParams = {
          path: norm.path,
          query,
          glob,
          regex: params.regex === true,
          caseSensitive: params.caseSensitive !== false,
          context: clampInt(params.context, 0, 0, GREP_MAX_CONTEXT),
          limit: clampInt(params.limit, GREP_DEFAULT_LIMIT, 1, GREP_MAX_LIMIT),
          outputMode,
        };
        const inv = await invoke(
          toolCallId,
          'grepFiles',
          'grep',
          normalizedParams,
        );
        if (!inv.ok) return inv.result;
        return toolOk(formatGrepResult(inv.data, norm.path, query, outputMode));
      },
    },
  ];
}
