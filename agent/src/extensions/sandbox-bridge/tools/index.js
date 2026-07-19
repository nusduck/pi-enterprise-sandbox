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
  DEFAULT_PROCESS_TIMEOUT_SEC,
  DEFAULT_PYTHON_TIMEOUT_SEC,
  DEFAULT_READ_LIMIT,
  MAX_BASH_COMMAND_LEN,
  MAX_BASH_TIMEOUT_SEC,
  MAX_CURSOR_LEN,
  MAX_PATH_LEN,
  MAX_PROCESS_ID_LEN,
  MAX_PROCESS_TIMEOUT_SEC,
  MAX_PYTHON_ARGS,
  MAX_PYTHON_CODE_BYTES,
  MAX_PYTHON_TIMEOUT_SEC,
  MAX_READ_BYTES,
  MAX_READ_LIMIT,
  MAX_STDOUT_CAPTURE,
  MAX_WRITE_BYTES,
  PARALLEL_TOOLS,
  PROCESS_SIGNALS,
  SANDBOX_TOOL_NAMES,
} from '../constants.js';
import { normalizeBoundedEnv } from '../env-guards.js';
import {
  normalizeLogicalPath,
  normalizeWritePath,
} from '../path-guards.js';
import { toolErr, toolOk, toolResultJson, truncateText } from '../result.js';
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

  function modeFor(name) {
    return PARALLEL_TOOLS.has(name) ? 'parallel' : 'sequential';
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
        'Read a file from the sandbox workspace (or skill read-only root). Supports offset/limit pagination.',
      promptSnippet: 'Read workspace or skill files with pagination',
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

        const offset = Number(params.offset ?? 0);
        const limit = Math.min(
          Number(params.limit ?? DEFAULT_READ_LIMIT),
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
            area: 'skill',
          };
          const inv = await invoke(
            toolCallId,
            'readSkill',
            'read',
            normalizedParams,
          );
          if (!inv.ok) return inv.result;
          return formatReadResult(inv.data, norm.path);
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
        return formatReadResult(inv.data, norm.path);
      },
    },

    // ── write ──────────────────────────────────────────────────────────
    {
      name: 'write',
      label: 'Write file',
      description:
        'Atomically write a file under the sandbox workspace (utf-8 or base64). Does not create artifacts.',
      promptSnippet: 'Write files to workspace',
      parameters: Type.Object({
        path: Type.String({ maxLength: MAX_PATH_LEN }),
        content: Type.String({ maxLength: MAX_WRITE_BYTES }),
        encoding: Type.Optional(
          Type.Union([Type.Literal('utf-8'), Type.Literal('base64')]),
        ),
      }),
      executionMode: modeFor('write'),
      async execute(toolCallId, params) {
        const norm = normalizeWritePath(params.path);
        if (!norm.ok) return toolErr(norm.code, norm.reason);
        const encoding = params.encoding === 'base64' ? 'base64' : 'utf-8';
        const content = String(params.content ?? '');
        if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) {
          return toolErr('CONTENT_TOO_LARGE', 'content exceeds max write size');
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
        return toolOk(
          toolResultJson({
            ok: true,
            path: norm.path,
            size: data?.size ?? null,
            encoding,
          }),
          { path: norm.path, size: data?.size },
        );
      },
    },

    // ── edit ───────────────────────────────────────────────────────────
    {
      name: 'edit',
      label: 'Edit file',
      description:
        'Edit a workspace file with expected content hash/version (optimistic concurrency).',
      promptSnippet: 'Edit workspace files with version precondition',
      parameters: Type.Object({
        path: Type.String({ maxLength: MAX_PATH_LEN }),
        oldText: Type.Optional(Type.String({ maxLength: MAX_WRITE_BYTES })),
        newText: Type.Optional(Type.String({ maxLength: MAX_WRITE_BYTES })),
        expectedHash: Type.Optional(Type.String({ maxLength: 128 })),
        expectedVersion: Type.Optional(Type.Union([Type.String(), Type.Integer()])),
      }),
      executionMode: modeFor('edit'),
      async execute(toolCallId, params) {
        const norm = normalizeWritePath(params.path);
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
            'edit requires expectedHash or expectedVersion',
          );
        }
        /** @type {Record<string, unknown>} */
        const normalizedParams = {
          path: norm.path,
        };
        if (params.oldText != null) normalizedParams.oldText = String(params.oldText);
        if (params.newText != null) normalizedParams.newText = String(params.newText);
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
        return toolOk(
          toolResultJson({
            ok: true,
            path: norm.path,
            hash: data?.hash ?? null,
            version: data?.version ?? null,
          }),
        );
      },
    },

    // ── bash ───────────────────────────────────────────────────────────
    {
      name: 'bash',
      label: 'Bash',
      description:
        'Run a shell command in the sandbox workspace. Ordinary commands do not require approval.',
      promptSnippet: 'Run sandbox bash commands',
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
          return toolErr('COMMAND_TOO_LONG', 'command exceeds max length');
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
        const data = inv.data;
        const stdout = truncateText(data?.stdout ?? '', MAX_STDOUT_CAPTURE);
        const stderr = truncateText(data?.stderr ?? '', MAX_STDOUT_CAPTURE);
        return toolOk(
          toolResultJson({
            exitCode: data?.exitCode ?? null,
            stdout: stdout.text,
            stderr: stderr.text,
            stdoutTruncated: stdout.truncated,
            stderrTruncated: stderr.truncated,
          }),
        );
      },
    },

    // ── python ─────────────────────────────────────────────────────────
    {
      name: 'python',
      label: 'Python',
      description:
        'Execute Python code in the sandbox. Long/multiline code is materialized by Sandbox (not shell heredoc).',
      promptSnippet: 'Run Python in sandbox',
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
          return toolErr('CODE_TOO_LARGE', 'code exceeds max size');
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
        const stdout = truncateText(data?.stdout ?? '', MAX_STDOUT_CAPTURE);
        const stderr = truncateText(data?.stderr ?? '', MAX_STDOUT_CAPTURE);
        return toolOk(
          toolResultJson({
            exitCode: data?.exitCode ?? null,
            stdout: stdout.text,
            stderr: stderr.text,
            materializedPath: data?.materializedPath ?? null,
            pythonVersion: data?.pythonVersion ?? null,
          }),
        );
      },
    },

    // ── process_start ──────────────────────────────────────────────────
    {
      name: 'process_start',
      label: 'Start process',
      description: 'Start a long-running process in the sandbox; returns process handle.',
      promptSnippet: 'Start long-running sandbox process',
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
        return toolOk(
          toolResultJson({
            processId: data?.processId ?? null,
            status: data?.status ?? 'running',
            stdoutCursor: data?.stdoutCursor ?? '0-0',
            stderrCursor: data?.stderrCursor ?? '0-0',
          }),
        );
      },
    },

    // ── process_status ─────────────────────────────────────────────────
    {
      name: 'process_status',
      label: 'Process status',
      description: 'Get status of a sandbox process handle.',
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
        return toolOk(toolResultJson(inv.data ?? {}));
      },
    },

    // ── process_read ───────────────────────────────────────────────────
    {
      name: 'process_read',
      label: 'Process read',
      description: 'Read incremental stdout/stderr from a process by cursor.',
      parameters: Type.Object({
        processId: Type.String({ maxLength: MAX_PROCESS_ID_LEN }),
        stream: Type.Optional(
          Type.Union([Type.Literal('stdout'), Type.Literal('stderr')]),
        ),
        cursor: Type.Optional(Type.String({ maxLength: MAX_CURSOR_LEN })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 65536 })),
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
        const limit = Math.min(Number(params.limit ?? 8192), 65536);
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
        const chunk = truncateText(data?.data ?? data?.chunk ?? '', MAX_STDOUT_CAPTURE);
        return toolOk(
          toolResultJson({
            processId,
            stream: data?.stream ?? stream,
            cursor: data?.cursor ?? cursor,
            nextCursor: data?.nextCursor ?? null,
            data: chunk.text,
            truncated: chunk.truncated,
            completed: Boolean(data?.completed),
            status: data?.status ?? null,
          }),
        );
      },
    },

    // ── process_kill ───────────────────────────────────────────────────
    {
      name: 'process_kill',
      label: 'Process kill',
      description: 'Signal a sandbox process (TERM|KILL|INT). Default TERM.',
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
            processId,
            signal,
            status: data?.status ?? 'running',
          }),
        );
      },
    },

    // ── submit_artifact ────────────────────────────────────────────────
    {
      name: 'submit_artifact',
      label: 'Submit artifact',
      description:
        'Submit a workspace file as an artifact (explicit only; no auto-scan).',
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
        const artifact = {
          artifactId: data?.artifactId ?? null,
          displayName:
            data?.displayName ?? data?.name ?? params.displayName ?? null,
          description: normalizedParams.description ?? null,
          sha256: data?.sha256 ?? null,
          size: data?.size ?? null,
          mimeType: data?.mimeType ?? null,
        };
        return toolOk(
          toolResultJson({
            ...artifact,
            path: norm.path,
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
 * @param {any} data
 * @param {string} path
 */
function formatReadResult(data, path) {
  if (data?.binary || data?.isBinary) {
    return toolOk(
      toolResultJson({
        path,
        binary: true,
        size: data.size ?? null,
        mimeType: data.mimeType ?? null,
      }),
    );
  }
  const body = truncateText(data?.content ?? data?.text ?? '', MAX_READ_BYTES);
  return toolOk(
    toolResultJson({
      path,
      content: body.text,
      truncated: body.truncated || Boolean(data?.truncated),
      offset: data?.offset ?? 0,
      limit: data?.limit ?? null,
      size: data?.size ?? null,
    }),
  );
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
