/**
 * Production sandboxTransport adapter for sandbox-bridge 10 tools (PR-08).
 *
 * Every call goes over the signed internal plane (`/internal/v1/*`). There is
 * no browser-Bearer fallback: the container refuses to build a runtime without
 * an HMAC keyring, so a missing transport here is a wiring bug, not a
 * deployment mode — it must fail loudly rather than silently downgrade.
 *
 * Session binding: payload.identity.sandboxSessionId (required by bridge).
 */

import { createEnterpriseExtensionBundle } from '../../extensions/index.js';
import { SANDBOX_TRANSPORT_METHODS } from '../../extensions/sandbox-bridge/transport.js';
import { normalizeProcessStatus } from '../../domain/process-status.js';

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
 * @template T
 * @param {T | null | undefined} transport
 * @param {string} method
 * @returns {T}
 */
function requireInternal(transport, method) {
  if (!transport || typeof (/** @type {any} */ (transport)[method]) !== 'function') {
    const err = new Error(
      `SANDBOX_INTERNAL_TRANSPORT_UNAVAILABLE: ${method} requires the signed internal plane`,
    );
    /** @type {any} */ (err).code = 'SANDBOX_INTERNAL_TRANSPORT_UNAVAILABLE';
    throw err;
  }
  return transport;
}

/**
 * Build the 13-method sandboxTransport expected by sandbox-bridge.
 *
 * @param {{
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
 *   internalSearchTransport?: {
 *     lsFiles: (payload: object) => Promise<object>,
 *     findFiles: (payload: object) => Promise<object>,
 *     grepFiles: (payload: object) => Promise<object>,
 *   } | null,
 *   internalFilesWriteTransport?: { writeFile: Function, editFile: Function } | null,
 *   internalArtifactTransport?: { submitArtifact: Function } | null,
 * }} [opts]
 * @returns {Record<string, Function>}
 */
export function createSandboxBridgeHttpTransport(opts = {}) {
  const internalReadTransport = opts.internalReadTransport ?? null;
  const internalExecutionTransport = opts.internalExecutionTransport ?? null;
  const internalProcessTransport = opts.internalProcessTransport ?? null;
  const internalSearchTransport = opts.internalSearchTransport ?? null;
  const internalFilesWriteTransport = opts.internalFilesWriteTransport ?? null;
  const internalArtifactTransport = opts.internalArtifactTransport ?? null;

  /** @type {Record<string, Function>} */
  const transport = {
    async readFile(payload) {
      try {
        return await requireInternal(internalReadTransport, 'readFile').readFile(
          payload,
        );
      } catch (err) {
        rethrowTransport(err);
      }
    },

    async readSkill(payload) {
      try {
        if (
          !internalReadTransport ||
          typeof internalReadTransport.readSkill !== 'function'
        ) {
          const err = new Error(
            'SKILL_READ_UNSUPPORTED: signed Skill read transport is unavailable',
          );
          /** @type {any} */ (err).code = 'SKILL_READ_UNSUPPORTED';
          throw err;
        }
        return await internalReadTransport.readSkill(payload);
      } catch (err) {
        rethrowTransport(err);
      }
    },

    async lsFiles(payload) {
      try {
        return await requireInternal(internalSearchTransport, 'lsFiles').lsFiles(
          payload,
        );
      } catch (err) {
        rethrowTransport(err);
      }
    },

    async findFiles(payload) {
      try {
        return await requireInternal(
          internalSearchTransport,
          'findFiles',
        ).findFiles(payload);
      } catch (err) {
        rethrowTransport(err);
      }
    },

    async grepFiles(payload) {
      try {
        return await requireInternal(
          internalSearchTransport,
          'grepFiles',
        ).grepFiles(payload);
      } catch (err) {
        rethrowTransport(err);
      }
    },

    async writeFile(payload) {
      try {
        return await requireInternal(
          internalFilesWriteTransport,
          'writeFile',
        ).writeFile(payload);
      } catch (err) {
        rethrowTransport(err);
      }
    },

    async editFile(payload) {
      try {
        return await requireInternal(
          internalFilesWriteTransport,
          'editFile',
        ).editFile(payload);
      } catch (err) {
        rethrowTransport(err);
      }
    },

    async bash(payload) {
      try {
        return await requireInternal(internalExecutionTransport, 'bash').bash(
          payload,
        );
      } catch (err) {
        rethrowTransport(err);
      }
    },

    async python(payload) {
      try {
        return await requireInternal(internalExecutionTransport, 'python').python(
          payload,
        );
      } catch (err) {
        rethrowTransport(err);
      }
    },

    async processStart(payload) {
      try {
        const data = await requireInternal(
          internalProcessTransport,
          'processStart',
        ).processStart(payload);
        return {
          processId: data?.processId ?? null,
          status: normalizeProcessStatus(data?.status, 'running'),
          stdoutCursor: data?.stdoutCursor ?? '0-0',
          stderrCursor: data?.stderrCursor ?? '0-0',
          startedAt: data?.startedAt ?? null,
        };
      } catch (err) {
        rethrowTransport(err);
      }
    },

    async processStatus(payload) {
      try {
        const data = await requireInternal(
          internalProcessTransport,
          'processStatus',
        ).processStatus(payload);
        return {
          processId: data?.processId ?? payload?.processId,
          status: normalizeProcessStatus(data?.status),
          exitCode: data?.exitCode ?? null,
          startedAt: data?.startedAt ?? null,
          elapsedSeconds: data?.elapsedSeconds ?? null,
          pid: data?.pid ?? null,
          stdoutCursor: data?.stdoutCursor ?? '0-0',
          stderrCursor: data?.stderrCursor ?? '0-0',
        };
      } catch (err) {
        rethrowTransport(err);
      }
    },

    async processRead(payload) {
      try {
        const data = await requireInternal(
          internalProcessTransport,
          'processRead',
        ).processRead(payload);
        return {
          processId: data?.processId ?? payload?.processId,
          stream: data?.stream ?? payload?.stream ?? 'stdout',
          cursor: data?.cursor ?? payload?.cursor ?? '0-0',
          nextCursor: data?.nextCursor ?? payload?.cursor ?? '0-0',
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
        const data = await requireInternal(
          internalProcessTransport,
          'processKill',
        ).processKill(payload);
        // Never fabricate SIGNALED on a refused signal.
        if (data?.ok === false || data?.signaled === false) {
          const err = new Error(data?.error || 'Process signal not delivered');
          /** @type {any} */ (err).code = 'PROCESS_SIGNAL_NOT_DELIVERED';
          /** @type {any} */ (err).status = 409;
          throw err;
        }
        return {
          processId: data?.processId ?? payload?.processId,
          signal: data?.signal ?? payload?.signal ?? 'TERM',
          status: normalizeProcessStatus(data?.status, 'running'),
          signaled: data?.signaled !== false,
        };
      } catch (err) {
        rethrowTransport(err);
      }
    },

    async submitArtifact(payload) {
      try {
        return await requireInternal(
          internalArtifactTransport,
          'submitArtifact',
        ).submitArtifact(payload);
      } catch (err) {
        rethrowTransport(err);
      }
    },
  };

  // Fail closed if a required method is missing on the transport adapter.
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
 * Build a **request-scoped** transport from durable runContext identity.
 *
 * The signed internal plane carries the acting identity in its request binding,
 * so the run context is validated here and handed to the per-run internal
 * transport factories — never taken from a job body or client-supplied subject.
 *
 * @param {object} runContext — frozen executor eventContext (orgId, userId, traceId, …)
 * @param {{
 *   createTransport?: typeof createSandboxBridgeHttpTransport,
 *   createInternalReadTransport?: (runContext: object) => object,
 *   createInternalExecutionTransport?: (runContext: object) => object,
 *   createInternalProcessTransport?: (runContext: object) => object,
 *   createInternalSearchTransport?: (runContext: object) => object,
 *   createInternalFilesWriteTransport?: (runContext: object) => object,
 *   createInternalArtifactTransport?: (runContext: object) => object,
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

  const makeTransport = opts.createTransport ?? createSandboxBridgeHttpTransport;
  const perRun = (factory) =>
    typeof factory === 'function' ? factory(runContext) : null;

  return makeTransport({
    internalReadTransport: perRun(opts.createInternalReadTransport),
    internalExecutionTransport: perRun(opts.createInternalExecutionTransport),
    internalProcessTransport: perRun(opts.createInternalProcessTransport),
    internalSearchTransport: perRun(opts.createInternalSearchTransport),
    internalFilesWriteTransport: perRun(opts.createInternalFilesWriteTransport),
    internalArtifactTransport: perRun(opts.createInternalArtifactTransport),
  });
}

/**
 * Factory for createEnterpriseExtensionBundle with HTTP transport wired.
 *
 * Prefer {@link createRunScopedSandboxBridgeTransport} via `createTransportForRun`
 * so each run gets its own signed transports. A static transport is tests-only.
 *
 * @param {{
 *   sandboxTransport?: object | null,
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
  const staticTransport = opts.sandboxTransport ?? null;
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
