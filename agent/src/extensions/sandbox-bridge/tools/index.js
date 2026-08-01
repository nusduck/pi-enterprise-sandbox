/**
 * sandbox-bridge tool definitions (plan §13) — exact 10 tools.
 * Uses typebox + Pi ToolDefinition / registerTool public API.
 *
 * PR-07B batch 1: every execute validates toolCallId before transport and
 * sends exact toolCallId + frozen identity (incl. executionFenceToken) on
 * every call. Model params cannot override identity/fence/toolCallId.
 *
 * PR-07B batch 2B: after final normalization, compute request-hash v1,
 * bind against RUNNING ToolExecution via sandboxRequestBinder, then
 * transport with top-level toolExecutionId/toolCallId/requestHash/
 * requestHashVersion. Fail closed with zero transport calls if binder
 * missing, bind fails, or ledger not RUNNING. Ordinary validation errors
 * stay toolErr codes (never reclassified as UNKNOWN).
 */

import { Type } from 'typebox';
import {
  DEFAULT_BASH_TIMEOUT_SEC,
  DEFAULT_PROCESS_READ_LIMIT,
  DEFAULT_PROCESS_TIMEOUT_SEC,
  DEFAULT_PYTHON_TIMEOUT_SEC,
  DEFAULT_READ_LIMIT,
  LARGE_FILE_HINT_BYTES,
  MAX_BASH_COMMAND_LEN,
  MAX_BASH_TIMEOUT_SEC,
  MAX_CURSOR_LEN,
  MAX_EXEC_RESULT_BYTES,
  MAX_EXEC_STREAM_BYTES,
  MAX_EXEC_STREAM_LINES,
  MAX_PATH_LEN,
  MAX_PROCESS_ID_LEN,
  MAX_PROCESS_READ_LIMIT,
  MAX_PROCESS_TIMEOUT_SEC,
  MAX_PYTHON_ARGS,
  MAX_PYTHON_CODE_BYTES,
  MAX_PYTHON_TIMEOUT_SEC,
  MAX_READ_BYTES,
  MAX_READ_CHARS,
  MAX_READ_LIMIT,
  MAX_READ_LINE_LENGTH,
  MAX_WRITE_BYTES,
  PARALLEL_TOOLS,
  PROCESS_SIGNALS,
  SANDBOX_TOOL_NAMES,
  WRITE_CONTENT_SOFT_WARN_BYTES,
} from '../constants.js';
import { normalizeBoundedEnv } from '../env-guards.js';
import {
  normalizeLogicalPath,
  normalizeWritePath,
} from '../path-guards.js';
import {
  DEFAULT_TOOL_OUTPUT_LINES,
  toolErr,
  toolOk,
  toolResultJson,
  truncateToCharBudget,
  truncateToolOutput,
} from '../result.js';
import {
  buildTransportCallPayload,
  buildTransportIdentity,
  callTransport,
  normalizeTransportToolCallId,
} from '../transport.js';
import {
  computeToolRequestHashV1,
  ToolRequestHashError,
} from '../../../domain/tool/tool-request-hash.js';
import { assertUlid } from '../../../domain/shared/ulid.js';
import { normalizeProcessStatus } from '../../../domain/process-status.js';

/** JSON envelope budget for read — content is pre-bounded to MAX_READ_CHARS. */
const MAX_READ_RESULT_BYTES = MAX_READ_CHARS + 8 * 1024;
/** Hermes-style soft block after repeated identical read pages in one run. */
const READ_DEDUP_SOFT_HITS = 1;
const READ_DEDUP_HARD_HITS = 2;
/**
 * Majority of non-empty lines look like read-tool gutters (`12|...`).
 * Writing that back is almost always a model mistake (Hermes refuses it).
 */
const READ_GUTTER_LINE_RE = /^\d+\|/;

function normalizeProcessTransportResult(toolName, data) {
  if (!toolName.startsWith('process_') || !data || typeof data !== 'object') {
    return data;
  }
  if (toolName === 'process_read' && data.status == null) return data;
  const fallback = toolName === 'process_start' || toolName === 'process_kill'
    ? 'running'
    : null;
  return { ...data, status: normalizeProcessStatus(data.status, fallback) };
}

/**
 * @param {object} runContext
 * @param {object} transport
 * @param {{
 *   sandboxRequestBinder?: {
 *     bindSandboxRequest: (input: {
 *       toolCallId: string,
 *       requestHash: string,
 *       requestHashVersion: number,
 *     }) => Promise<{
 *       toolExecutionId: string,
 *       requestHash?: string,
 *       requestHashVersion?: number,
 *       bound?: boolean,
 *       toolExecution?: object,
 *     }>
 *   } | null,
 * }} [opts]
 * @returns {import('@earendil-works/pi-coding-agent').ToolDefinition[]}
 */
export function createSandboxBridgeToolDefinitions(
  runContext,
  transport,
  opts = {},
) {
  const identity = buildTransportIdentity(runContext);
  const binder = opts.sandboxRequestBinder ?? null;
  /**
   * Hermes-style read dedup within one run/tool-bundle instance.
   * Key: path + offset + limit → { fingerprint, hits }.
   * Soft-hit returns a stub (saves context); hard-hit blocks loops.
   * @type {Map<string, { fingerprint: string, hits: number }>}
   */
  const readDedup = new Map();

  function modeFor(name) {
    return PARALLEL_TOOLS.has(name) ? 'parallel' : 'sequential';
  }

  /**
   * @param {string} path
   * @param {number} offset
   * @param {number} limit
   * @param {string} fingerprint
   * @returns {{ action: 'proceed' } | { action: 'stub' | 'block', hits: number }}
   */
  function noteReadDedup(path, offset, limit, fingerprint) {
    const key = `${path}\0${offset}\0${limit}`;
    const prev = readDedup.get(key);
    if (!prev || prev.fingerprint !== fingerprint) {
      readDedup.set(key, { fingerprint, hits: 0 });
      // Cap map growth on pathological agents.
      if (readDedup.size > 256) {
        const first = readDedup.keys().next().value;
        if (first != null) readDedup.delete(first);
      }
      return { action: 'proceed' };
    }
    const hits = prev.hits + 1;
    prev.hits = hits;
    if (hits >= READ_DEDUP_HARD_HITS) {
      return { action: 'block', hits: hits + 1 };
    }
    if (hits >= READ_DEDUP_SOFT_HITS) {
      return { action: 'stub', hits: hits + 1 };
    }
    return { action: 'proceed' };
  }

  /** After write/edit, cached read pages for that path are stale. */
  function invalidateReadDedupForPath(path) {
    const prefix = `${path}\0`;
    for (const key of readDedup.keys()) {
      if (key.startsWith(prefix)) readDedup.delete(key);
    }
  }

  /**
   * Format + Hermes-style dedup for model-facing read results.
   * @param {any} data
   * @param {string} path
   * @param {number} offset
   * @param {number} limit
   */
  function finalizeReadResult(data, path, offset, limit) {
    const { payload, fingerprint } = formatReadResult(
      data,
      path,
      offset,
      limit,
    );
    if (payload.binary) {
      return toolOk(toolResultJson(payload, MAX_READ_RESULT_BYTES));
    }
    const dedup = noteReadDedup(path, offset, limit, fingerprint);
    if (dedup.action === 'block') {
      return toolErr(
        'READ_DEDUP_BLOCKED',
        `You have re-read this exact region ${dedup.hits} times and the content has not changed. Stop re-reading; use the earlier read_file result and proceed.`,
        { path, offset, limit, alreadyRead: dedup.hits },
      );
    }
    if (dedup.action === 'stub') {
      return toolOk(
        toolResultJson(
          {
            status: 'unchanged',
            path,
            offset,
            limit,
            dedup: true,
            content_returned: false,
            message:
              'File region unchanged since the last identical read in this run. Reuse the earlier content instead of re-reading.',
          },
          MAX_READ_RESULT_BYTES,
        ),
      );
    }
    return toolOk(toolResultJson(payload, MAX_READ_RESULT_BYTES));
  }

  /**
   * Shared: toolCallId gate → post-normalization hash → bind → transport.
   * Identity, toolCallId, and claim/hash fields are applied last so model
   * params cannot override them.
   *
   * @param {unknown} toolCallId
   * @param {string} method
   * @param {string} toolName
   * @param {object} normalizedParams
   * @returns {Promise<{ ok: true, data: any } | { ok: false, result: object }>}
   */
  async function invoke(toolCallId, method, toolName, normalizedParams) {
    const idCheck = normalizeTransportToolCallId(toolCallId);
    if (!idCheck.ok) {
      return {
        ok: false,
        result: toolErr(idCheck.code, idCheck.reason),
      };
    }

    if (
      !binder ||
      typeof binder.bindSandboxRequest !== 'function'
    ) {
      return {
        ok: false,
        result: toolErr(
          'SANDBOX_REQUEST_BINDER_UNAVAILABLE',
          'sandboxRequestBinder was not injected; refuse transport without ledger bind',
        ),
      };
    }

    let hashOut;
    try {
      hashOut = computeToolRequestHashV1({
        toolName,
        args: normalizedParams ?? {},
      });
    } catch (err) {
      if (err instanceof ToolRequestHashError) {
        return {
          ok: false,
          result: toolErr(err.code || 'TOOL_REQUEST_HASH_INVALID', err.message),
        };
      }
      throw err;
    }

    /** @type {{ toolExecutionId: string, requestHash: string, requestHashVersion: number }} */
    let claim;
    try {
      const bound = await binder.bindSandboxRequest({
        toolCallId: idCheck.toolCallId,
        toolName,
        requestHash: hashOut.requestHash,
        requestHashVersion: hashOut.requestHashVersion,
      });
      if (!bound || typeof bound.toolExecutionId !== 'string') {
        return {
          ok: false,
          result: toolErr(
            'SANDBOX_REQUEST_BIND_FAILED',
            'bindSandboxRequest did not return toolExecutionId',
          ),
        };
      }
      // Exact ULID required before any transport call.
      let toolExecutionId;
      try {
        toolExecutionId = assertUlid(bound.toolExecutionId, 'toolExecutionId');
      } catch {
        return {
          ok: false,
          result: toolErr(
            'SANDBOX_REQUEST_BIND_FAILED',
            'bindSandboxRequest returned invalid toolExecutionId (not a ULID)',
          ),
        };
      }
      claim = {
        toolExecutionId,
        requestHash: hashOut.requestHash,
        requestHashVersion: hashOut.requestHashVersion,
      };
    } catch (err) {
      return {
        ok: false,
        result: mapBindError(err),
      };
    }

    try {
      const data = await callTransport(
        transport,
        method,
        buildTransportCallPayload(
          identity,
          idCheck.toolCallId,
          normalizedParams,
          claim,
        ),
      );
      return { ok: true, data: normalizeProcessTransportResult(toolName, data) };
    } catch (err) {
      return { ok: false, result: mapTransportError(err) };
    }
  }

  /** @type {import('@earendil-works/pi-coding-agent').ToolDefinition[]} */
  const tools = [
    // ── read ───────────────────────────────────────────────────────────
    {
      name: 'read',
      label: 'Read file',
      description:
        `Read a text file from the sandbox workspace, session temporary directory, or skill root. Pagination uses 0-based offset (default 0) and limit (default ${DEFAULT_READ_LIMIT}, max ${MAX_READ_LIMIT} lines). Output uses LINE_NUM|CONTENT gutters, is capped at ${DEFAULT_TOOL_OUTPUT_LINES} lines or ~${Math.floor(MAX_READ_CHARS / 1000)}k characters (whichever first), and returns nextOffset when truncated. Prefer read over cat/sed.`,
      promptSnippet: 'Read workspace, temporary, or skill files with pagination',
      promptGuidelines: [
        'Use read to inspect files instead of cat or sed.',
        'Keep following nextOffset until the needed range is complete; do not re-read the same offset/limit page.',
        'For large files, start with a section map (headings/grep) then read targeted ranges.',
      ],
      parameters: Type.Object({
        path: Type.String({ maxLength: MAX_PATH_LEN }),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(
          Type.Integer({ minimum: 1, maximum: MAX_READ_LIMIT }),
        ),
      }),
      executionMode: modeFor('read'),
      async execute(toolCallId, params) {
        const allowSkill = true;
        const norm = normalizeLogicalPath(params.path, {
          allowSkillRead: allowSkill,
        });
        if (!norm.ok) return toolErr(norm.code, norm.reason);

        const offset = Math.max(0, Number(params.offset ?? 0) || 0);
        const limit = Math.min(
          Math.max(1, Number(params.limit ?? DEFAULT_READ_LIMIT) || DEFAULT_READ_LIMIT),
          MAX_READ_LIMIT,
        );

        if (norm.area === 'skill') {
          if (typeof transport.readSkill !== 'function') {
            // Validate toolCallId even when skill path is unsupported so
            // invalid ids fail consistently before any transport attempt.
            const idCheck = normalizeTransportToolCallId(toolCallId);
            if (!idCheck.ok) return toolErr(idCheck.code, idCheck.reason);
            return toolErr(
              'SKILL_READ_UNSUPPORTED',
              'skill read is not supported by transport (no readSkill)',
            );
          }
          // skill-read path: hash under registered tool name "read" with
          // post-normalization params (same ledger contract as workspace read).
          const normalizedParams = {
            path: norm.path,
            offset,
            limit,
            maxBytes: MAX_READ_BYTES,
          };
          const inv = await invoke(
            toolCallId,
            'readSkill',
            'read',
            normalizedParams,
          );
          if (!inv.ok) return inv.result;
          return finalizeReadResult(inv.data, norm.path, offset, limit);
        }
        const normalizedParams = {
          path: norm.path,
          offset,
          limit,
          maxBytes: MAX_READ_BYTES,
        };
        const inv = await invoke(
          toolCallId,
          'readFile',
          'read',
          normalizedParams,
        );
        if (!inv.ok) return inv.result;
        return finalizeReadResult(inv.data, norm.path, offset, limit);
      },
    },

    // ── write ──────────────────────────────────────────────────────────
    {
      name: 'write',
      label: 'Write file',
      description:
        `Atomically create or fully replace a workspace or /tmp file (utf-8 or base64). OVERWRITES the entire file — use edit for targeted changes. Max ${Math.floor(MAX_WRITE_BYTES / 1024)}KB. Does not create user-visible artifacts (use submit_artifact). Prefer write over echo/cat heredoc.`,
      promptSnippet: 'Write workspace or temporary files',
      promptGuidelines: [
        'Use write for new files or deliberate complete rewrites.',
        'Use edit for a targeted change to an existing file.',
        'Do not paste read-tool LINE_NUM|CONTENT gutters back into write.',
        'Do not dump multi-megabyte blobs; keep content focused.',
      ],
      parameters: Type.Object({
        path: Type.String({ maxLength: MAX_PATH_LEN }),
        content: Type.String({ maxLength: MAX_WRITE_BYTES }),
        encoding: Type.Optional(
          Type.Union([Type.Literal('utf-8'), Type.Literal('base64')]),
        ),
      }),
      executionMode: modeFor('write'),
      async execute(toolCallId, params) {
        const norm = normalizeWritePath(params.path, { allowTemp: true });
        if (!norm.ok) return toolErr(norm.code, norm.reason);
        const encoding = params.encoding === 'base64' ? 'base64' : 'utf-8';
        const content = String(params.content ?? '');
        const contentBytes = Buffer.byteLength(content, 'utf8');
        if (contentBytes > MAX_WRITE_BYTES) {
          return toolErr(
            'CONTENT_TOO_LARGE',
            `content exceeds max write size (${MAX_WRITE_BYTES} bytes)`,
          );
        }
        if (encoding === 'utf-8' && looksLikeReadFileGutterContent(content)) {
          return toolErr(
            'WRITE_LOOKS_LIKE_READ_OUTPUT',
            'Refusing to write internal read-tool display text (LINE_NUM|CONTENT). Strip gutters or reconstruct the intended file content.',
          );
        }
        const normalizedParams = {
          path: norm.path,
          content,
          encoding,
        };
        const inv = await invoke(
          toolCallId,
          'writeFile',
          'write',
          normalizedParams,
        );
        if (!inv.ok) return inv.result;
        const data = inv.data;
        invalidateReadDedupForPath(norm.path);
        const size =
          data?.size != null && Number.isFinite(Number(data.size))
            ? Number(data.size)
            : contentBytes;
        /** @type {Record<string, unknown>} */
        const payload = {
          ok: true,
          path: norm.path,
          bytesWritten: size,
          size,
          encoding,
          hash: data?.hash ?? null,
          version: data?.version ?? null,
        };
        if (contentBytes >= WRITE_CONTENT_SOFT_WARN_BYTES) {
          payload.warning =
            `Large write (${contentBytes} bytes). Prefer smaller files or generate content via sandbox code when possible.`;
        }
        return toolOk(toolResultJson(payload), {
          path: norm.path,
          size,
        });
      },
    },

    // ── edit ───────────────────────────────────────────────────────────
    {
      name: 'edit',
      label: 'Edit file',
      description:
        'Exact oldText→newText replacement in a workspace or /tmp file. Requires expectedHash or expectedVersion (optimistic concurrency) and a unique oldText. Prefer edit over sed/awk; use write only for full rewrites.',
      promptSnippet: 'Edit workspace or temporary files with a version precondition',
      promptGuidelines: [
        'Read the file first and pass expectedHash or expectedVersion from that read.',
        'Keep oldText as small as possible while unique; merge nearby changes into one edit.',
        'Do not include read-tool LINE_NUM|CONTENT gutters in oldText/newText.',
        'Use write only for complete rewrites.',
      ],
      parameters: Type.Object({
        path: Type.String({ maxLength: MAX_PATH_LEN }),
        oldText: Type.Optional(Type.String({ maxLength: MAX_WRITE_BYTES })),
        newText: Type.Optional(Type.String({ maxLength: MAX_WRITE_BYTES })),
        expectedHash: Type.Optional(Type.String({ maxLength: 128 })),
        expectedVersion: Type.Optional(Type.Union([Type.String(), Type.Integer()])),
      }),
      executionMode: modeFor('edit'),
      async execute(toolCallId, params) {
        const norm = normalizeWritePath(params.path, { allowTemp: true });
        if (!norm.ok) return toolErr(norm.code, norm.reason);
        const expectedHash =
          params.expectedHash != null ? String(params.expectedHash).trim() : '';
        const expectedVersion =
          params.expectedVersion != null
            ? String(params.expectedVersion).trim()
            : '';
        if (!expectedHash && !expectedVersion) {
          return toolErr(
            'FILE_VERSION_PRECONDITION_REQUIRED',
            'edit requires expectedHash or expectedVersion from a prior read',
          );
        }
        if (params.oldText == null || String(params.oldText).length === 0) {
          return toolErr(
            'OLD_TEXT_REQUIRED',
            'edit requires non-empty oldText (exact unique match in the file)',
          );
        }
        if (params.newText == null) {
          return toolErr(
            'NEW_TEXT_REQUIRED',
            'edit requires newText (use empty string to delete the matched span)',
          );
        }
        const oldText = String(params.oldText);
        const newText = String(params.newText);
        if (
          looksLikeReadFileGutterContent(oldText) ||
          looksLikeReadFileGutterContent(newText)
        ) {
          return toolErr(
            'EDIT_LOOKS_LIKE_READ_OUTPUT',
            'oldText/newText look like read-tool gutters (LINE_NUM|CONTENT). Use raw file text without line-number prefixes.',
          );
        }
        /** @type {Record<string, unknown>} */
        const normalizedParams = {
          path: norm.path,
          oldText,
          newText,
        };
        if (expectedHash) normalizedParams.expectedHash = expectedHash;
        if (expectedVersion) normalizedParams.expectedVersion = expectedVersion;
        const inv = await invoke(
          toolCallId,
          'editFile',
          'edit',
          normalizedParams,
        );
        if (!inv.ok) return inv.result;
        const data = inv.data;
        invalidateReadDedupForPath(norm.path);
        return toolOk(
          toolResultJson({
            ok: true,
            path: norm.path,
            hash: data?.hash ?? null,
            version: data?.version ?? null,
            replaced: data?.replaced ?? 1,
            message: `Successfully replaced text in ${norm.path}.`,
          }),
        );
      },
    },

    // ── bash ───────────────────────────────────────────────────────────
    {
      name: 'bash',
      label: 'Bash',
      description:
        `Run a shell command in the sandbox workspace. stdout and stderr are each capped at ~${Math.floor(MAX_EXEC_STREAM_BYTES / 1024)}KB / ${MAX_EXEC_STREAM_LINES} lines (whichever first). Prefer read for files; use head/tail/rg when output may be large. Default timeout ${DEFAULT_BASH_TIMEOUT_SEC}s (max ${MAX_BASH_TIMEOUT_SEC}s).`,
      promptSnippet: 'Run sandbox bash commands',
      promptGuidelines: [
        'Use read for file inspection; use bash for commands and narrow diagnostics.',
        'Prefer bounded output such as head, tail, or focused filters; never dump whole large files via cat.',
        'On truncation, narrow the command rather than re-running the same dump.',
      ],
      parameters: Type.Object({
        command: Type.String({ maxLength: MAX_BASH_COMMAND_LEN }),
        timeoutSeconds: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: MAX_BASH_TIMEOUT_SEC,
          }),
        ),
        env: Type.Optional(Type.Record(Type.String(), Type.String())),
      }),
      executionMode: modeFor('bash'),
      async execute(toolCallId, params) {
        const command = String(params.command ?? '');
        if (!command.trim()) {
          return toolErr('COMMAND_REQUIRED', 'command is required');
        }
        if (command.length > MAX_BASH_COMMAND_LEN) {
          return toolErr(
            'COMMAND_TOO_LONG',
            `command exceeds max length (${MAX_BASH_COMMAND_LEN})`,
          );
        }
        const envNorm = normalizeBoundedEnv(params.env);
        if (!envNorm.ok) return toolErr(envNorm.code, envNorm.reason);
        const timeoutSeconds = Math.min(
          Number(params.timeoutSeconds ?? DEFAULT_BASH_TIMEOUT_SEC),
          MAX_BASH_TIMEOUT_SEC,
        );
        const normalizedParams = {
          command,
          timeoutSeconds,
          env: envNorm.env,
        };
        const inv = await invoke(
          toolCallId,
          'bash',
          'bash',
          normalizedParams,
        );
        if (!inv.ok) return inv.result;
        return toolOk(
          toolResultJson(formatExecStreams(inv.data), MAX_EXEC_RESULT_BYTES),
        );
      },
    },

    // ── python ─────────────────────────────────────────────────────────
    {
      name: 'python',
      label: 'Python',
      description:
        `Execute Python in the sandbox (Sandbox materializes long code; not shell heredoc). stdout/stderr each capped at ~${Math.floor(MAX_EXEC_STREAM_BYTES / 1024)}KB / ${MAX_EXEC_STREAM_LINES} lines. Default timeout ${DEFAULT_PYTHON_TIMEOUT_SEC}s. Print summaries, not whole files.`,
      promptSnippet: 'Run Python in sandbox',
      promptGuidelines: [
        'Use Python for structured computation or focused file analysis, not as an unbounded file dump.',
        'Print summaries or selected ranges so results remain actionable.',
        'On truncation, re-run with tighter prints or pagination.',
      ],
      parameters: Type.Object({
        code: Type.String({ maxLength: MAX_PYTHON_CODE_BYTES }),
        args: Type.Optional(
          Type.Array(Type.String({ maxLength: 1024 }), {
            maxItems: MAX_PYTHON_ARGS,
          }),
        ),
        timeoutSeconds: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: MAX_PYTHON_TIMEOUT_SEC,
          }),
        ),
      }),
      executionMode: modeFor('python'),
      async execute(toolCallId, params) {
        const code = String(params.code ?? '');
        if (!code.trim()) {
          return toolErr('CODE_REQUIRED', 'code is required');
        }
        if (Buffer.byteLength(code, 'utf8') > MAX_PYTHON_CODE_BYTES) {
          return toolErr(
            'CODE_TOO_LARGE',
            `code exceeds max size (${MAX_PYTHON_CODE_BYTES} bytes)`,
          );
        }
        const args = Array.isArray(params.args)
          ? params.args.map(String).slice(0, MAX_PYTHON_ARGS)
          : [];
        const timeoutSeconds = Math.min(
          Number(params.timeoutSeconds ?? DEFAULT_PYTHON_TIMEOUT_SEC),
          MAX_PYTHON_TIMEOUT_SEC,
        );
        const normalizedParams = {
          code,
          args,
          timeoutSeconds,
        };
        const inv = await invoke(
          toolCallId,
          'python',
          'python',
          normalizedParams,
        );
        if (!inv.ok) return inv.result;
        const data = inv.data;
        const payload = formatExecStreams(data, {
          extras: {
            materializedPath: data?.materializedPath ?? null,
            pythonVersion: data?.pythonVersion ?? null,
          },
        });
        return toolOk(toolResultJson(payload, MAX_EXEC_RESULT_BYTES));
      },
    },

    // ── process_start ──────────────────────────────────────────────────
    {
      name: 'process_start',
      label: 'Start process',
      description:
        `Start a long-running sandbox process and return a processId plus stream cursors. Use process_read to poll output and process_kill to stop. Default lifetime timeout ${DEFAULT_PROCESS_TIMEOUT_SEC}s (max ${MAX_PROCESS_TIMEOUT_SEC}s).`,
      promptSnippet: 'Start long-running sandbox process',
      promptGuidelines: [
        'Use process_start for servers, watchers, or jobs that outlive one bash call.',
        'Poll with process_read (stdout/stderr cursors) instead of re-starting.',
      ],
      parameters: Type.Object({
        command: Type.String({ maxLength: MAX_BASH_COMMAND_LEN }),
        env: Type.Optional(Type.Record(Type.String(), Type.String())),
        timeoutSeconds: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: MAX_PROCESS_TIMEOUT_SEC,
          }),
        ),
      }),
      executionMode: modeFor('process_start'),
      async execute(toolCallId, params) {
        const command = String(params.command ?? '');
        if (!command.trim()) {
          return toolErr('COMMAND_REQUIRED', 'command is required');
        }
        if (command.length > MAX_BASH_COMMAND_LEN) {
          return toolErr(
            'COMMAND_TOO_LONG',
            `command exceeds max length (${MAX_BASH_COMMAND_LEN})`,
          );
        }
        const envNorm = normalizeBoundedEnv(params.env);
        if (!envNorm.ok) return toolErr(envNorm.code, envNorm.reason);
        const timeoutSeconds = Math.min(
          Number(params.timeoutSeconds ?? DEFAULT_PROCESS_TIMEOUT_SEC),
          MAX_PROCESS_TIMEOUT_SEC,
        );
        const normalizedParams = {
          command,
          env: envNorm.env,
          timeoutSeconds,
        };
        const inv = await invoke(
          toolCallId,
          'processStart',
          'process_start',
          normalizedParams,
        );
        if (!inv.ok) return inv.result;
        const data = inv.data;
        const handle = {
          processId: data?.processId ?? null,
          status: data?.status ?? 'running',
          stdoutCursor: data?.stdoutCursor ?? '0-0',
          stderrCursor: data?.stderrCursor ?? '0-0',
        };
        // `details` carries the handle out of the model-facing text so the
        // governance recorder can put processId on tool.execution.completed —
        // that is what links a tool step to its process console.
        return toolOk(
          toolResultJson({
            ok: true,
            ...handle,
            message:
              'Process started. Use process_read with the cursors to consume output.',
          }),
          handle,
        );
      },
    },

    // ── process_status ─────────────────────────────────────────────────
    {
      name: 'process_status',
      label: 'Process status',
      description:
        'Get status of a sandbox process handle (running/exited/etc). Prefer process_read when you need new output.',
      promptSnippet: 'Check sandbox process status',
      parameters: Type.Object({
        processId: Type.String({ maxLength: MAX_PROCESS_ID_LEN }),
      }),
      executionMode: modeFor('process_status'),
      async execute(toolCallId, params) {
        const processId = String(params.processId ?? '').trim();
        if (!processId || processId.length > MAX_PROCESS_ID_LEN) {
          return toolErr('PROCESS_ID_INVALID', 'processId is required');
        }
        const normalizedParams = { processId };
        const inv = await invoke(
          toolCallId,
          'processStatus',
          'process_status',
          normalizedParams,
        );
        if (!inv.ok) return inv.result;
        const data = inv.data && typeof inv.data === 'object' ? inv.data : {};
        return toolOk(
          toolResultJson({
            processId,
            status: data.status ?? null,
            exitCode: data.exitCode ?? data.exit_code ?? null,
            ...data,
          }),
        );
      },
    },

    // ── process_read ───────────────────────────────────────────────────
    {
      name: 'process_read',
      label: 'Process read',
      description:
        `Read incremental stdout/stderr from a process by cursor. Default limit ${DEFAULT_PROCESS_READ_LIMIT} bytes of chunk data (max ${MAX_PROCESS_READ_LIMIT}). When truncated, continue with nextCursor.`,
      promptSnippet: 'Read sandbox process output streams',
      promptGuidelines: [
        'Always pass the latest nextCursor to avoid re-reading the same chunk.',
        'Use stream=stderr when diagnosing failures.',
      ],
      parameters: Type.Object({
        processId: Type.String({ maxLength: MAX_PROCESS_ID_LEN }),
        stream: Type.Optional(
          Type.Union([Type.Literal('stdout'), Type.Literal('stderr')]),
        ),
        cursor: Type.Optional(Type.String({ maxLength: MAX_CURSOR_LEN })),
        limit: Type.Optional(
          Type.Integer({ minimum: 1, maximum: MAX_PROCESS_READ_LIMIT }),
        ),
      }),
      executionMode: modeFor('process_read'),
      async execute(toolCallId, params) {
        const processId = String(params.processId ?? '').trim();
        if (!processId) {
          return toolErr('PROCESS_ID_INVALID', 'processId is required');
        }
        const cursor = params.cursor != null ? String(params.cursor) : '0-0';
        if (cursor.length > MAX_CURSOR_LEN) {
          return toolErr('CURSOR_INVALID', 'cursor too long');
        }
        const stream = params.stream === 'stderr' ? 'stderr' : 'stdout';
        const limit = Math.min(
          Math.max(1, Number(params.limit ?? DEFAULT_PROCESS_READ_LIMIT) || DEFAULT_PROCESS_READ_LIMIT),
          MAX_PROCESS_READ_LIMIT,
        );
        const normalizedParams = {
          processId,
          stream,
          cursor,
          limit,
        };
        const inv = await invoke(
          toolCallId,
          'processRead',
          'process_read',
          normalizedParams,
        );
        if (!inv.ok) return inv.result;
        const data = inv.data;
        const chunk = truncateToolOutput(data?.data ?? data?.chunk ?? '', {
          maxBytes: MAX_EXEC_STREAM_BYTES,
          maxLines: MAX_EXEC_STREAM_LINES,
        });
        const nextCursor = data?.nextCursor ?? null;
        const truncated = chunk.truncated || Boolean(data?.truncated);
        /** @type {Record<string, unknown>} */
        const payload = {
          processId,
          stream: data?.stream ?? stream,
          cursor: data?.cursor ?? cursor,
          nextCursor,
          data: chunk.text,
          truncated,
          truncatedBy: chunk.truncatedBy ?? (data?.truncated ? 'upstream' : null),
          totalBytes: chunk.totalBytes,
          totalLines: chunk.totalLines,
          completed: Boolean(data?.completed),
          status: data?.status ?? null,
        };
        if (truncated && nextCursor) {
          payload.continuation = `Stream truncated; continue with cursor=${nextCursor}.`;
        } else if (truncated) {
          payload.continuation =
            'Stream chunk truncated at the model-facing budget; request a smaller limit or re-read with the latest cursor.';
        }
        return toolOk(toolResultJson(payload, MAX_EXEC_RESULT_BYTES));
      },
    },

    // ── process_kill ───────────────────────────────────────────────────
    {
      name: 'process_kill',
      label: 'Process kill',
      description:
        'Signal a sandbox process (TERM|KILL|INT). Default TERM. Prefer TERM first; use KILL only if the process ignores TERM.',
      promptSnippet: 'Stop a sandbox process',
      parameters: Type.Object({
        processId: Type.String({ maxLength: MAX_PROCESS_ID_LEN }),
        signal: Type.Optional(
          Type.Union(
            PROCESS_SIGNALS.map((s) => Type.Literal(s)),
          ),
        ),
      }),
      executionMode: modeFor('process_kill'),
      async execute(toolCallId, params) {
        const processId = String(params.processId ?? '').trim();
        if (!processId) {
          return toolErr('PROCESS_ID_INVALID', 'processId is required');
        }
        const signal = PROCESS_SIGNALS.includes(/** @type {any} */ (params.signal))
          ? params.signal
          : 'TERM';
        const normalizedParams = {
          processId,
          signal,
        };
        const inv = await invoke(
          toolCallId,
          'processKill',
          'process_kill',
          normalizedParams,
        );
        if (!inv.ok) return inv.result;
        const data = inv.data;
        return toolOk(
          toolResultJson({
            ok: true,
            processId,
            signal,
            status: data?.status ?? 'running',
            message: `Sent ${signal} to process ${processId}.`,
          }),
        );
      },
    },

    // ── submit_artifact ────────────────────────────────────────────────
    {
      name: 'submit_artifact',
      label: 'Submit artifact',
      description:
        'Register a workspace file as a user-visible artifact (explicit only; no auto-scan of the workspace). Path must be under the workspace (not /tmp or skill).',
      promptSnippet: 'Publish a workspace file as an artifact',
      promptGuidelines: [
        'Only submit finished deliverables the user should download.',
        'Write/edit the file first; then submit_artifact with a clear displayName.',
      ],
      parameters: Type.Object({
        path: Type.String({ maxLength: MAX_PATH_LEN }),
        displayName: Type.Optional(Type.String({ maxLength: 256 })),
        description: Type.Optional(Type.String({ maxLength: 1024 })),
      }),
      executionMode: modeFor('submit_artifact'),
      async execute(toolCallId, params) {
        const norm = normalizeWritePath(params.path);
        // artifact path must be workspace file (write-path rules = workspace only)
        if (!norm.ok) return toolErr(norm.code, norm.reason);
        /** @type {Record<string, unknown>} */
        const normalizedParams = {
          path: norm.path,
        };
        if (params.displayName != null) {
          normalizedParams.displayName = String(params.displayName).slice(0, 256);
        }
        if (params.description != null) {
          normalizedParams.description = String(params.description).slice(0, 1024);
        }
        const inv = await invoke(
          toolCallId,
          'submitArtifact',
          'submit_artifact',
          normalizedParams,
        );
        if (!inv.ok) return inv.result;
        const data = inv.data;
        const artifactId = data?.artifactId ?? null;
        // Browser-relative download path (BFF). Prefer this over inventing a
        // sandbox-local HTTP server. session_id MUST be the sandbox session
        // ULID — never agentSessionId.
        const sandboxSessionId =
          identity?.sandboxSessionId != null
            ? String(identity.sandboxSessionId)
            : null;
        const downloadPath =
          artifactId && sandboxSessionId
            ? `/api/files/artifact-download?session_id=${encodeURIComponent(sandboxSessionId)}&artifact_id=${encodeURIComponent(String(artifactId))}`
            : null;
        // Durable details stay compact (SSE / UI); model content can include path/message.
        const artifact = {
          artifactId,
          displayName:
            data?.displayName ?? data?.name ?? params.displayName ?? null,
          description: normalizedParams.description ?? null,
          sha256: data?.sha256 ?? null,
          size: data?.size ?? null,
          mimeType: data?.mimeType ?? null,
          downloadPath,
        };
        return toolOk(
          toolResultJson({
            ok: true,
            ...artifact,
            path: norm.path,
            message: artifactId
              ? 'Artifact registered for user download.'
              : 'Artifact submission completed.',
          }),
          artifact,
          { maxDetailString: 1024 },
        );
      },
    },
  ];

  // Exact 10 — fail closed if drift
  if (tools.length !== SANDBOX_TOOL_NAMES.length) {
    throw new Error(
      `sandbox-bridge must register exactly ${SANDBOX_TOOL_NAMES.length} tools`,
    );
  }
  const names = tools.map((t) => t.name);
  for (let i = 0; i < SANDBOX_TOOL_NAMES.length; i += 1) {
    if (names[i] !== SANDBOX_TOOL_NAMES[i]) {
      throw new Error(
        `sandbox-bridge tool order mismatch at ${i}: expected ${SANDBOX_TOOL_NAMES[i]}, got ${names[i]}`,
      );
    }
  }
  return tools;
}

/**
 * True when content is dominated by read-tool gutters (`12|...`).
 * @param {string} content
 */
export function looksLikeReadFileGutterContent(content) {
  const text = String(content ?? '');
  if (!text.trim()) return false;
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length < 2) return false;
  let hits = 0;
  for (const line of lines) {
    if (READ_GUTTER_LINE_RE.test(line)) hits += 1;
  }
  return hits / lines.length >= 0.7;
}

/**
 * Hermes/Pi-aligned exec stream bounding for bash/python.
 * @param {any} data
 * @param {{ extras?: Record<string, unknown> }} [opts]
 */
export function formatExecStreams(data, opts = {}) {
  const stdout = truncateToolOutput(data?.stdout ?? '', {
    maxBytes: MAX_EXEC_STREAM_BYTES,
    maxLines: MAX_EXEC_STREAM_LINES,
  });
  const stderr = truncateToolOutput(data?.stderr ?? '', {
    maxBytes: MAX_EXEC_STREAM_BYTES,
    maxLines: MAX_EXEC_STREAM_LINES,
  });
  /** @type {Record<string, unknown>} */
  const payload = {
    exitCode: data?.exitCode ?? data?.exit_code ?? null,
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    stdoutTruncatedBy: stdout.truncatedBy,
    stderrTruncatedBy: stderr.truncatedBy,
    stdoutTotalBytes: stdout.totalBytes,
    stderrTotalBytes: stderr.totalBytes,
    stdoutTotalLines: stdout.totalLines,
    stderrTotalLines: stderr.totalLines,
    stdoutOutputLines: stdout.outputLines,
    stderrOutputLines: stderr.outputLines,
  };
  if (stdout.truncated) {
    payload.stdoutContinuation =
      `stdout truncated by ${stdout.truncatedBy} (showing ${stdout.outputLines}/${stdout.totalLines} lines, ${stdout.outputBytes}/${stdout.totalBytes} bytes). Re-run with a narrower command (head/tail/rg).`;
  }
  if (stderr.truncated) {
    payload.stderrContinuation =
      `stderr truncated by ${stderr.truncatedBy} (showing ${stderr.outputLines}/${stderr.totalLines} lines). Re-run with a narrower command.`;
  }
  if (opts.extras && typeof opts.extras === 'object') {
    Object.assign(payload, opts.extras);
  }
  return payload;
}

/**
 * Compact gutter `LINE_NUM|CONTENT` (Hermes / Pi style). Line numbers are
 * 1-based file coordinates: page start at 0-based `offset` → first line is
 * `offset + 1`.
 *
 * @param {string} source
 * @param {number} offset0
 * @param {number} maxLineLength
 * @returns {string}
 */
export function formatReadContentWithGutter(source, offset0, maxLineLength = MAX_READ_LINE_LENGTH) {
  const text = String(source ?? '');
  if (!text) return '';
  const lines = text.split('\n');
  const start = Math.max(0, Number(offset0) || 0);
  const maxLen = Math.max(1, Number(maxLineLength) || MAX_READ_LINE_LENGTH);
  /** @type {string[]} */
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i];
    if (line.length > maxLen) {
      line = `${line.slice(0, maxLen)}... [truncated]`;
    }
    out.push(`${start + i + 1}|${line}`);
  }
  return out.join('\n');
}

/**
 * Stable fingerprint for dedup (size + content head/tail hash proxy).
 * @param {string} content
 * @param {unknown} size
 */
function readContentFingerprint(content, size) {
  const text = String(content ?? '');
  const head = text.slice(0, 256);
  const tail = text.length > 256 ? text.slice(-256) : '';
  return `${size ?? ''}|${text.length}|${head.length}:${head}|${tail.length}:${tail}`;
}

/**
 * Build model-facing read payload (Hermes-aligned gutters + char budget).
 * @param {any} data
 * @param {string} path
 * @param {number} requestOffset
 * @param {number} requestLimit
 */
export function formatReadResult(data, path, requestOffset = 0, requestLimit = DEFAULT_READ_LIMIT) {
  if (data?.binary || data?.isBinary) {
    return {
      payload: {
        path,
        binary: true,
        size: data.size ?? null,
        mimeType: data.mimeType ?? null,
      },
      fingerprint: `binary:${data?.size ?? ''}:${data?.mimeType ?? ''}`,
    };
  }

  const offset = Math.max(
    0,
    Number(data?.offset ?? requestOffset ?? 0) || 0,
  );
  const limit =
    data?.limit != null
      ? Number(data.limit)
      : requestLimit;
  const source = String(data?.content ?? data?.text ?? '');
  const guttered = formatReadContentWithGutter(
    source,
    offset,
    MAX_READ_LINE_LENGTH,
  );

  // Line-count cap first (Hermes max_lines / Pi DEFAULT_MAX_LINES).
  const lineBound = truncateToolOutput(guttered, {
    maxBytes: Number.MAX_SAFE_INTEGER,
    maxLines: DEFAULT_TOOL_OUTPUT_LINES,
  });
  let bodyText = lineBound.text;
  let linesKept = lineBound.completedLines;
  let truncated = lineBound.truncated || Boolean(data?.truncated);
  /** @type {string | null} */
  let truncatedBy = lineBound.truncated ? lineBound.truncatedBy : null;
  let partialLine = Boolean(lineBound.partialLine);

  // Character budget (Hermes file_read_max_chars) — whole lines only.
  const charBound = truncateToCharBudget(bodyText, MAX_READ_CHARS);
  if (charBound.truncated) {
    bodyText = charBound.text;
    linesKept = charBound.partialLine ? 0 : charBound.linesKept;
    truncated = true;
    truncatedBy = 'chars';
    partialLine = charBound.partialLine;
  }

  // Bridge-side bounds override the sandbox cursor so we never skip unread
  // lines from a partially-rendered page.
  const bridgeTruncated =
    lineBound.truncated || charBound.truncated || partialLine;
  const nextOffset = bridgeTruncated
    ? offset + linesKept
    : data?.nextOffset ??
      data?.next_offset ??
      (data?.truncated ? offset + linesKept : null);

  /** @type {string | undefined} */
  let continuation;
  if (truncated) {
    if (partialLine && linesKept === 0) {
      continuation =
        'Read output is truncated inside the first line; use a narrower range or Python to inspect that line.';
    } else if (nextOffset != null) {
      const shownEnd = offset + Math.max(linesKept, 1);
      continuation =
        `Showing lines ${offset + 1}-${shownEnd}` +
        (truncatedBy ? ` (truncated by ${truncatedBy})` : '') +
        `. Continue with offset=${nextOffset}.`;
    } else {
      continuation = 'Read output is truncated.';
    }
  }

  const size =
    data?.size != null && Number.isFinite(Number(data.size))
      ? Number(data.size)
      : null;
  /** @type {string | undefined} */
  let hint;
  if (
    size != null &&
    size > LARGE_FILE_HINT_BYTES &&
    (limit == null || limit > 200)
  ) {
    hint =
      'Large file: prefer targeted offset/limit ranges or a section map before reading the whole document.';
  }

  const payload = {
    path,
    content: bodyText,
    truncated,
    truncatedBy,
    totalBytes: Buffer.byteLength(source, 'utf8'),
    totalLines: lineBound.totalLines,
    offset,
    limit: limit ?? null,
    size,
    nextOffset,
    ...(continuation ? { continuation } : {}),
    ...(hint ? { hint } : {}),
  };

  return {
    payload,
    fingerprint: readContentFingerprint(bodyText, size),
  };
}

/**
 * Bind failures stay explicit codes — never UNKNOWN (UNKNOWN is only for
 * ambiguous post-claim transport outcomes later).
 * @param {unknown} err
 */
function mapBindError(err) {
  const code =
    /** @type {any} */ (err)?.code ||
    (/** @type {any} */ (err)?.name === 'NotFoundError'
      ? 'TOOL_EXECUTION_NOT_FOUND'
      : /** @type {any} */ (err)?.name === 'ConflictError'
        ? 'SANDBOX_REQUEST_BIND_CONFLICT'
        : 'SANDBOX_REQUEST_BIND_FAILED');
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : 'sandbox request bind failed';
  // Ordinary bind/ledger failures are never mapped to UNKNOWN.
  const safeCode =
    String(code) === 'UNKNOWN' || String(code) === 'TOOL_OUTCOME_UNKNOWN'
      ? 'SANDBOX_REQUEST_BIND_FAILED'
      : String(code);
  return toolErr(safeCode, msg);
}

/**
 * Stable ledger / one-shot outcome codes from Sandbox internal transport.
 * Must pass through to tool details — never collapse into SANDBOX_ERROR.
 * (Bare "UNKNOWN" remains remapped; "TOOL_OUTCOME_UNKNOWN" is intentional.)
 */
const PRESERVED_TRANSPORT_ERROR_CODES = new Set([
  'IN_PROGRESS',
  'TOOL_OUTCOME_UNKNOWN',
  'CANCELLED',
]);

/**
 * Detect authoritative outcome-unknown from transport only.
 * Accepts strict boolean marker and/or exact code TOOL_OUTCOME_UNKNOWN.
 * Does not accept string "true", 1, or arbitrary details.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isTransportOutcomeUnknown(err) {
  const e = /** @type {any} */ (err);
  if (!e || typeof e !== 'object') return false;
  if (e.outcomeUnknown === true) return true;
  return e.code === 'TOOL_OUTCOME_UNKNOWN';
}

/**
 * @param {unknown} err
 */
function mapTransportError(err) {
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : 'sandbox transport error';

  // Ambiguous Sandbox outcome: fixed code + fixed boolean marker only.
  // Never spread arbitrary error fields into tool details (anti-spoof).
  if (isTransportOutcomeUnknown(err)) {
    return toolErr('TOOL_OUTCOME_UNKNOWN', msg, { outcomeUnknown: true });
  }

  const code =
    /** @type {any} */ (err)?.code ||
    (/** @type {any} */ (err)?.message?.includes('SANDBOX_TRANSPORT')
      ? 'SANDBOX_TRANSPORT_UNAVAILABLE'
      : 'SANDBOX_ERROR');
  const codeStr = String(code);
  // Preserve IN_PROGRESS / CANCELLED. Only remap bare UNKNOWN.
  const safeCode = PRESERVED_TRANSPORT_ERROR_CODES.has(codeStr)
    ? codeStr
    : codeStr === 'UNKNOWN'
      ? 'SANDBOX_ERROR'
      : codeStr;
  // No extra details object — avoid leaking transport internals.
  return toolErr(safeCode, msg);
}

export { SANDBOX_TOOL_NAMES };
