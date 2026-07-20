/**
 * Production sandboxTransport adapter for sandbox-bridge 10 tools (PR-08).
 *
 * Maps camelCase transport methods + frozen identity/claim payloads onto the
 * service-identity Sandbox HTTP client (never browser Bearer alone).
 *
 * Session binding: payload.identity.sandboxSessionId (required by bridge).
 */

import { createSandboxClient } from './sandbox-client.js';
import { createEnterpriseExtensionBundle } from '../../extensions/index.js';
import { SANDBOX_TRANSPORT_METHODS } from '../../extensions/sandbox-bridge/transport.js';
import { normalizeProcessStatus } from '../../domain/process-status.js';

/**
 * @param {Record<string, unknown>} payload
 * @returns {string}
 */
function requireSessionId(payload) {
  const identity =
    payload && typeof payload === 'object' && payload.identity
      ? /** @type {Record<string, unknown>} */ (payload.identity)
      : null;
  const sid =
    (identity && identity.sandboxSessionId) ||
    (payload && payload.sandboxSessionId) ||
    null;
  const s = sid != null ? String(sid).trim() : '';
  if (!s || s === 'null' || s === 'undefined') {
    const err = new Error(
      'SANDBOX_SESSION_REQUIRED: identity.sandboxSessionId is required',
    );
    /** @type {any} */ (err).code = 'SANDBOX_SESSION_REQUIRED';
    throw err;
  }
  return s;
}

/**
 * Map TERM|KILL|INT / SIG* → sandbox signal API names.
 * @param {unknown} signal
 * @returns {string}
 */
function mapSignal(signal) {
  const raw = String(signal ?? 'TERM').trim().toUpperCase();
  if (raw.startsWith('SIG')) return raw;
  if (raw === 'TERM' || raw === 'KILL' || raw === 'INT' || raw === 'HUP') {
    return `SIG${raw}`;
  }
  return raw.startsWith('SIG') ? raw : 'SIGTERM';
}

/**
 * @param {any} err
 * @returns {never}
 */
function rethrowTransport(err) {
  const code = err?.code || (err?.status === 404 ? 'NOT_FOUND' : 'SANDBOX_ERROR');
  const e = new Error(err?.message || String(err));
  /** @type {any} */ (e).code = code;
  /** @type {any} */ (e).status = err?.status ?? err?.httpStatus;
  /** @type {any} */ (e).httpStatus = err?.httpStatus ?? err?.status;
  if (err?.outcomeUnknown === true) {
    /** @type {any} */ (e).outcomeUnknown = true;
  }
  if (err?.cause != null) {
    /** @type {any} */ (e).cause = err.cause;
  }
  throw e;
}

/**
 * Build the 10-method sandboxTransport expected by sandbox-bridge.
 *
 * @param {{
 *   client?: ReturnType<typeof createSandboxClient> | null,
 *   createClient?: () => any,
 *   traceId?: string | null,
 *   auth?: object | null,
 *   internalReadTransport?: {
 *     readFile: (payload: object) => Promise<object>,
 *     readSkill?: (payload: object) => Promise<object>,
 *   } | null,
 *   internalExecutionTransport?: {
 *     bash: (payload: object) => Promise<object>,
 *     python: (payload: object) => Promise<object>,
 *   } | null,
 *   internalProcessTransport?: {
 *     processStart: (payload: object) => Promise<object>,
 *     processStatus: (payload: object) => Promise<object>,
 *     processRead: (payload: object) => Promise<object>,
 *     processKill: (payload: object) => Promise<object>,
 *   } | null,
 *   internalFilesWriteTransport?: { writeFile: Function, editFile: Function } | null,
 *   internalArtifactTransport?: { submitArtifact: Function } | null,
 * }} [opts]
 * @returns {Record<string, Function>}
 */
export function createSandboxBridgeHttpTransport(opts = {}) {
  const client =
    opts.client ??
    (typeof opts.createClient === 'function'
      ? opts.createClient()
      : createSandboxClient({
          traceId: opts.traceId ?? null,
          auth: opts.auth ?? null,
        }));
  const internalReadTransport = opts.internalReadTransport ?? null;
  const internalExecutionTransport = opts.internalExecutionTransport ?? null;
  const internalProcessTransport = opts.internalProcessTransport ?? null;
  const internalFilesWriteTransport = opts.internalFilesWriteTransport ?? null;
  const internalArtifactTransport = opts.internalArtifactTransport ?? null;

  /** @type {Record<string, Function>} */
  const transport = {
    async readFile(payload) {
      try {
        if (internalReadTransport) {
          return await internalReadTransport.readFile(payload);
        }
        const sessionId = requireSessionId(payload);
        const path = String(payload?.path ?? '');
        const offset = payload?.offset != null ? Number(payload.offset) : 0;
        const limit = payload?.limit != null ? Number(payload.limit) : undefined;
        if (
          typeof client.readFileWithRange === 'function' &&
          (offset > 0 || limit != null)
        ) {
          return await client.readFileWithRange(sessionId, path, offset, limit);
        }
        const data = await client.readFile(sessionId, path);
        return {
          content: data?.content ?? data?.text ?? '',
          offset: data?.offset ?? offset,
          limit: data?.limit ?? limit ?? null,
          path: data?.path ?? path,
          binary: Boolean(data?.binary),
          truncated: Boolean(data?.truncated),
          size: data?.size ?? null,
          mimeType: data?.mime_type ?? data?.mimeType ?? null,
        };
      } catch (err) {
        rethrowTransport(err);
      }
    },

    async readSkill(payload) {
      try {
        if (!internalReadTransport || typeof internalReadTransport.readSkill !== 'function') {
          const err = new Error('SKILL_READ_UNSUPPORTED: signed Skill read transport is unavailable');
          /** @type {any} */ (err).code = 'SKILL_READ_UNSUPPORTED';
          throw err;
        }
        return await internalReadTransport.readSkill(payload);
      } catch (err) {
        rethrowTransport(err);
      }
    },

    async writeFile(payload) {
      try {
        if (internalFilesWriteTransport) {
          return await internalFilesWriteTransport.writeFile(payload);
        }
        const sessionId = requireSessionId(payload);
        const path = String(payload?.path ?? '');
        const content = String(payload?.content ?? '');
        const data = await client.writeFile(sessionId, path, content);
        return {
          size: data?.size ?? null,
          path: data?.path ?? path,
        };
      } catch (err) {
        rethrowTransport(err);
      }
    },

    async editFile(payload) {
      try {
        if (internalFilesWriteTransport) {
          return await internalFilesWriteTransport.editFile(payload);
        }
        const sessionId = requireSessionId(payload);
        const body = {
          path: String(payload?.path ?? ''),
          old_str: payload?.oldString ?? payload?.old_str,
          new_str: payload?.newString ?? payload?.new_str,
          expected_hash: payload?.expectedHash ?? payload?.expected_hash,
          expected_version: payload?.expectedVersion ?? payload?.version,
        };
        const data = await client.editFile(sessionId, body);
        return {
          hash: data?.hash ?? data?.content_hash ?? null,
          version: data?.version ?? null,
          path: data?.path ?? body.path,
        };
      } catch (err) {
        rethrowTransport(err);
      }
    },

    async bash(payload) {
      try {
        if (internalExecutionTransport) {
          return await internalExecutionTransport.bash(payload);
        }
        const sessionId = requireSessionId(payload);
        const command = String(payload?.command ?? '');
        const timeout = Number(
          payload?.timeoutSeconds ?? payload?.timeout ?? 120,
        );
        const data = await client.executeCommand(sessionId, command, timeout);
        return {
          exitCode: data?.exit_code ?? data?.exitCode ?? null,
          stdout: data?.stdout_preview ?? data?.stdout ?? '',
          stderr: data?.stderr_preview ?? data?.stderr ?? '',
          truncated: Boolean(data?.truncated),
          durationMs: data?.duration_ms ?? data?.durationMs ?? null,
        };
      } catch (err) {
        rethrowTransport(err);
      }
    },

    async python(payload) {
      try {
        if (internalExecutionTransport) {
          return await internalExecutionTransport.python(payload);
        }
        const sessionId = requireSessionId(payload);
        const code = String(payload?.code ?? '');
        const timeout = Number(
          payload?.timeoutSeconds ?? payload?.timeout ?? 120,
        );
        const args = Array.isArray(payload?.args) ? payload.args.map(String) : [];
        const data = await client.executePython(sessionId, code, timeout, {
          args,
        });
        return {
          exitCode: data?.exit_code ?? data?.exitCode ?? null,
          stdout: data?.stdout_preview ?? data?.stdout ?? '',
          stderr: data?.stderr_preview ?? data?.stderr ?? '',
          truncated: Boolean(data?.truncated),
          materializedPath:
            data?.materialized_path ?? data?.materializedPath ?? null,
          pythonVersion: data?.python_version ?? data?.pythonVersion ?? null,
          pythonMode: data?.python_mode ?? data?.pythonMode ?? null,
        };
      } catch (err) {
        rethrowTransport(err);
      }
    },

    async processStart(payload) {
      try {
        if (internalProcessTransport) {
          const data = await internalProcessTransport.processStart(payload);
          return {
            processId: data?.processId ?? data?.process_id ?? null,
            status: normalizeProcessStatus(data?.status, 'running'),
            stdoutCursor: data?.stdoutCursor ?? data?.stdout_cursor ?? '0-0',
            stderrCursor: data?.stderrCursor ?? data?.stderr_cursor ?? '0-0',
            startedAt: data?.startedAt ?? data?.started_at ?? null,
          };
        }
        const sessionId = requireSessionId(payload);
        const body = {
          session_id: sessionId,
          command: String(payload?.command ?? ''),
          env: payload?.env && typeof payload.env === 'object' ? payload.env : {},
          timeout:
            payload?.timeoutSeconds != null
              ? Number(payload.timeoutSeconds)
              : payload?.timeout != null
                ? Number(payload.timeout)
                : undefined,
          run_id:
            payload?.identity?.runId != null
              ? String(payload.identity.runId)
              : payload?.runId != null
                ? String(payload.runId)
                : undefined,
        };
        const data = await client.startProcess(body);
        return {
          processId: data?.process_id ?? data?.processId ?? null,
          status: normalizeProcessStatus(data?.status, 'running'),
          stdoutCursor: data?.stdout_cursor ?? data?.stdoutCursor ?? '0-0',
          stderrCursor: data?.stderr_cursor ?? data?.stderrCursor ?? '0-0',
          startedAt: data?.started_at ?? data?.startedAt ?? null,
        };
      } catch (err) {
        rethrowTransport(err);
      }
    },

    async processStatus(payload) {
      try {
        if (internalProcessTransport) {
          const data = await internalProcessTransport.processStatus(payload);
          return {
            processId: data?.processId ?? data?.process_id ?? payload?.processId,
            status: normalizeProcessStatus(data?.status), exitCode: data?.exitCode ?? data?.exit_code ?? null,
            startedAt: data?.startedAt ?? data?.started_at ?? null,
            elapsedSeconds: data?.elapsedSeconds ?? data?.elapsed_seconds ?? null,
            pid: data?.pid ?? null, stdoutCursor: data?.stdoutCursor ?? data?.stdout_cursor ?? '0-0',
            stderrCursor: data?.stderrCursor ?? data?.stderr_cursor ?? '0-0',
          };
        }
        const processId = String(payload?.processId ?? '').trim();
        const data = await client.getProcess(processId);
        return {
          processId: data?.process_id ?? processId,
          status: normalizeProcessStatus(data?.status),
          exitCode: data?.exit_code ?? data?.exitCode ?? null,
          startedAt: data?.started_at ?? data?.startedAt ?? null,
          elapsedSeconds:
            data?.elapsed_seconds ?? data?.elapsedSeconds ?? null,
          pid: data?.pid ?? null,
        };
      } catch (err) {
        rethrowTransport(err);
      }
    },

    async processRead(payload) {
      try {
        if (internalProcessTransport) {
          const data = await internalProcessTransport.processRead(payload);
          return {
            processId: data?.processId ?? data?.process_id ?? payload?.processId,
            stream: data?.stream ?? payload?.stream ?? 'stdout',
            cursor: data?.cursor ?? payload?.cursor ?? '0-0',
            nextCursor: data?.nextCursor ?? data?.next_cursor ?? payload?.cursor ?? '0-0',
            data: data?.data ?? '', truncated: Boolean(data?.truncated), completed: Boolean(data?.completed),
            status: data?.status != null ? normalizeProcessStatus(data.status) : null,
          };
        }
        const processId = String(payload?.processId ?? '').trim();
        const stream = payload?.stream === 'stderr' ? 'stderr' : 'stdout';
        const cursor = String(payload?.cursor ?? '0-0');
        const limit = Number(payload?.limit ?? 8192);
        const data = await client.readProcess(processId, {
          stream,
          cursor,
          limit,
        });
        return {
          processId,
          stream: data?.stream ?? stream,
          cursor: data?.cursor ?? cursor,
          nextCursor: data?.next_cursor ?? data?.nextCursor ?? cursor,
          data: data?.data ?? '',
          truncated: Boolean(data?.truncated),
          completed: Boolean(data?.completed),
          status: data?.status != null ? normalizeProcessStatus(data.status) : null,
        };
      } catch (err) {
        rethrowTransport(err);
      }
    },

    async processKill(payload) {
      try {
        if (internalProcessTransport) {
          const data = await internalProcessTransport.processKill(payload);
          if (data?.ok === false || data?.signaled === false) {
            const err = new Error(data?.error || 'Process signal not delivered');
            /** @type {any} */ (err).code = 'PROCESS_SIGNAL_NOT_DELIVERED';
            /** @type {any} */ (err).status = 409;
            throw err;
          }
          return { processId: data?.processId ?? data?.process_id ?? payload?.processId, signal: data?.signal ?? payload?.signal ?? 'TERM', status: normalizeProcessStatus(data?.status, 'running'), signaled: data?.signaled !== false };
        }
        const processId = String(payload?.processId ?? '').trim();
        const signal = mapSignal(payload?.signal);
        // signalProcess / cancelProcess throw SandboxError on non-2xx (409 when
        // not delivered). Never fallback-and-fabricate SIGNALED on failure.
        const data = await client.signalProcess(processId, signal);
        if (data?.ok === false || data?.signaled === false) {
          const err = new Error(
            data?.error || 'Process signal not delivered',
          );
          /** @type {any} */ (err).code = 'PROCESS_SIGNAL_NOT_DELIVERED';
          /** @type {any} */ (err).status = 409;
          throw err;
        }
        return {
          processId,
          signal: payload?.signal ?? 'TERM',
          status: normalizeProcessStatus(data?.status, 'running'),
          signaled: true,
        };
      } catch (err) {
        rethrowTransport(err);
      }
    },

    async submitArtifact(payload) {
      try {
        if (internalArtifactTransport) {
          return await internalArtifactTransport.submitArtifact(payload);
        }
        const sessionId = requireSessionId(payload);
        const path = String(payload?.path ?? '');
        const name =
          payload?.displayName != null
            ? String(payload.displayName)
            : path.split('/').pop() || 'artifact';
        const mime =
          payload?.mimeType != null
            ? String(payload.mimeType)
            : 'application/octet-stream';
        const data = await client.submitArtifact(sessionId, name, path, mime);
        return {
          artifactId: data?.artifact_id ?? data?.artifactId ?? null,
          sha256: data?.sha256 ?? null,
          size: data?.size ?? null,
          mimeType: data?.mime_type ?? data?.mimeType ?? mime,
          path: data?.path ?? path,
          name: data?.name ?? name,
        };
      } catch (err) {
        rethrowTransport(err);
      }
    },
  };

  // Fail closed if a required method is missing on the client adapter.
  for (const m of SANDBOX_TRANSPORT_METHODS) {
    if (typeof transport[m] !== 'function') {
      throw new Error(
        `SANDBOX_TRANSPORT_INCOMPLETE: missing method ${m} on http transport`,
      );
    }
  }

  return Object.freeze(transport);
}

/**
 * Build a **request-scoped** HTTP transport from durable runContext identity.
 *
 * Worker has no browser JWT. Sandbox ownership (auth on) requires service
 * X-API-Key + X-Acting-User-Id / X-Acting-Organization-Id from **durable**
 * run/session owner fields — never job body / client-supplied subjects.
 *
 * @param {object} runContext — frozen executor eventContext (orgId, userId, traceId, …)
 * @param {{
 *   createSandboxClient?: typeof createSandboxClient,
 *   createTransport?: typeof createSandboxBridgeHttpTransport,
 *   createInternalReadTransport?: (runContext: object) => object,
 *   createInternalExecutionTransport?: (runContext: object) => object,
 *   createInternalProcessTransport?: (runContext: object) => object,
 *   createInternalFilesWriteTransport?: (runContext: object) => object,
 *   createInternalArtifactTransport?: (runContext: object) => object,
 *   serviceApiTokenPresent?: boolean,
 * }} [opts]
 * @returns {Record<string, Function>}
 */
export function createRunScopedSandboxBridgeTransport(runContext, opts = {}) {
  if (!runContext || typeof runContext !== 'object' || Array.isArray(runContext)) {
    const err = new Error(
      'RUN_IDENTITY_REQUIRED: runContext object is required for Sandbox acting headers',
    );
    /** @type {any} */ (err).code = 'RUN_IDENTITY_REQUIRED';
    throw err;
  }
  const ctx = /** @type {Record<string, unknown>} */ (runContext);
  const orgId = String(ctx.orgId ?? '').trim();
  const userId = String(ctx.userId ?? '').trim();
  if (!orgId || orgId === 'null' || orgId === 'undefined') {
    const err = new Error(
      'RUN_IDENTITY_REQUIRED: durable runContext.orgId is required for Sandbox X-Acting-Organization-Id',
    );
    /** @type {any} */ (err).code = 'RUN_IDENTITY_REQUIRED';
    throw err;
  }
  if (!userId || userId === 'null' || userId === 'undefined') {
    const err = new Error(
      'RUN_IDENTITY_REQUIRED: durable runContext.userId is required for Sandbox X-Acting-User-Id',
    );
    /** @type {any} */ (err).code = 'RUN_IDENTITY_REQUIRED';
    throw err;
  }
  // Never invent identity from job payload — only frozen runContext fields.
  const traceRaw = ctx.traceId;
  const traceId =
    traceRaw != null && String(traceRaw).trim() && String(traceRaw).trim() !== 'null'
      ? String(traceRaw).trim()
      : null;
  const traceState =
    ctx.traceState == null ? null : String(ctx.traceState).trim() || null;

  const makeClient = opts.createSandboxClient ?? createSandboxClient;
  const makeTransport = opts.createTransport ?? createSandboxBridgeHttpTransport;
  const clientOptions = {
    traceId,
    auth: {
      actingUserId: userId,
      actingOrganizationId: orgId,
      actingRole: 'user',
    },
  };
  if (traceState) clientOptions.traceState = traceState;
  const client = makeClient(clientOptions);
  const internalReadTransport =
    typeof opts.createInternalReadTransport === 'function'
      ? opts.createInternalReadTransport(runContext)
      : null;
  const internalExecutionTransport =
    typeof opts.createInternalExecutionTransport === 'function'
      ? opts.createInternalExecutionTransport(runContext)
      : null;
  const internalProcessTransport =
    typeof opts.createInternalProcessTransport === 'function'
      ? opts.createInternalProcessTransport(runContext)
      : null;
  const internalFilesWriteTransport =
    typeof opts.createInternalFilesWriteTransport === 'function'
      ? opts.createInternalFilesWriteTransport(runContext)
      : null;
  const internalArtifactTransport =
    typeof opts.createInternalArtifactTransport === 'function'
      ? opts.createInternalArtifactTransport(runContext)
      : null;
  return makeTransport({
    client,
    traceId,
    traceState,
    auth: null,
    internalReadTransport,
    internalExecutionTransport,
    internalProcessTransport,
    internalFilesWriteTransport,
    internalArtifactTransport,
  });
}

/**
 * Factory for createEnterpriseExtensionBundle with HTTP transport wired.
 *
 * Prefer {@link createTransportForRun} so each run gets an isolated client
 * (acting headers + trace). A process-level shared client is tests-only.
 *
 * @param {{
 *   sandboxTransport?: object | null,
 *   sandboxClient?: any,
 *   createClient?: () => any,
 *   createTransportForRun?: (runContext: object, deps?: object) => object,
 *   createEnterpriseExtensionBundle?: Function,
 *   extraDeps?: object,
 * }} [opts]
 * @returns {(runContext: object, deps: object) => unknown[]}
 */
export function createSandboxBridgeExtensionBundleFactory(opts = {}) {
  const createTransportForRun =
    typeof opts.createTransportForRun === 'function'
      ? opts.createTransportForRun
      : null;
  /** Static transport only when explicitly provided (unit tests). */
  let staticTransport = opts.sandboxTransport ?? null;
  if (
    !staticTransport &&
    !createTransportForRun &&
    (opts.sandboxClient || typeof opts.createClient === 'function')
  ) {
    staticTransport = createSandboxBridgeHttpTransport({
      client: opts.sandboxClient ?? null,
      createClient: opts.createClient,
    });
  }
  const bundleFn =
    opts.createEnterpriseExtensionBundle ?? createEnterpriseExtensionBundle;

  return function extensionBundleFactory(runContext, deps = {}) {
    let transport = deps.sandboxTransport ?? null;
    if (!transport && createTransportForRun) {
      transport = createTransportForRun(runContext, deps);
    }
    if (!transport) {
      transport = staticTransport;
    }
    if (!transport) {
      const err = new Error(
        'SANDBOX_TRANSPORT_REQUIRED: per-run createTransportForRun or explicit sandboxTransport is required (no anonymous process-global client)',
      );
      /** @type {any} */ (err).code = 'SANDBOX_TRANSPORT_REQUIRED';
      throw err;
    }
    return bundleFn(runContext, {
      ...(opts.extraDeps || {}),
      ...deps,
      sandboxTransport: transport,
      governanceRecorder: deps.governanceRecorder,
      sandboxRequestBinder: deps.sandboxRequestBinder,
    });
  };
}
