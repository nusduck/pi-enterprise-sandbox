/**
 * A2A HTTP presentation (plan §20) — PR-12 severe follow-up.
 *
 * Routes:
 *   GET  /.well-known/agent-card.json
 *   POST /a2a  (credential-routed endpoint advertised by the root card)
 *   GET  /a2a/agents/{agentId}/.well-known/agent-card.json  (404 if agent meta missing)
 *   POST /a2a/agents/{agentId}   JSON-RPC 2.0
 *   GET  /a2a/artifacts/download?token=…  (bytes only when streamArtifactBytes injected)
 *
 * Auth: Authorization: Bearer <a2a_api_credential>
 * SSE: every data line is JSON-RPC; heartbeat is SSE comment.
 */

import { isUlid, assertUlid } from '../../domain/shared/ulid.js';
import { A2A_SCOPES, hasScope } from '../../domain/a2a/scopes.js';
import { A2aAuthError } from '../../application/a2a/credential-service.js';
import {
  A2aTaskError,
  A2aAuditError,
  requireStableIdempotencyKey,
} from '../../application/a2a/task-service.js';
import {
  A2A_METHODS,
  A2A_RPC_ERROR,
  JSON_RPC_ERROR,
  parseJsonRpcRequest,
  jsonRpcSuccess,
  jsonRpcError,
} from '../../application/a2a/json-rpc.js';
import {
  buildAgentCard,
  resolvePublicBaseUrl,
} from '../../application/a2a/agent-card.js';
import {
  verifyArtifactDownloadToken,
} from '../../application/a2a/artifact-download.js';
import { ValidationError } from '../../application/errors.js';
import { waitForWritableResume } from '../../application/run-event-sse-service.js';

/**
 * @param {{
 *   credentialService: { authenticate: Function },
 *   taskService: {
 *     sendMessage: Function,
 *     getTask: Function,
 *     cancelTask: Function,
 *     beginSubscribe?: Function,
 *     auditStreamEnd?: Function,
 *     auditArtifactDownload?: Function,
 *     resolveOwnedTask?: Function,
 *   },
 *   streamService: { openTaskStream: Function },
 *   resolveAgentMeta?: (agentId: string) => Promise<{ name?: string, description?: string } | null>,
 *   publicBaseUrl?: string | null,
 *   deploymentEnv?: string,
 *   allowDevHostFallback?: boolean,
 *   artifactDownloadSecret?: string | null,
 *   streamArtifactBytes?: ((ctx: object) => Promise<{
 *     body: AsyncIterable<Uint8Array|Buffer> | ReadableStream | null,
 *     contentType?: string | null,
 *     contentLength?: string | number | null,
 *     contentDisposition?: string | null,
 *     sha256?: string | null,
 *   }>) | null,
 *   createRepositories?: (db?: any) => any,
 *   db?: any,
 *   resolveTraceId: Function,
 *   resolveTraceContext?: Function,
 *   readBody: Function,
 *   json: Function,
 * }} deps
 */
export function createA2aHttpHandler(deps) {
  if (!deps?.credentialService?.authenticate) {
    throw new Error('createA2aHttpHandler requires credentialService');
  }
  if (!deps?.taskService) {
    throw new Error('createA2aHttpHandler requires taskService');
  }
  if (!deps?.streamService?.openTaskStream) {
    throw new Error('createA2aHttpHandler requires streamService');
  }

  /**
   * Resolve the full inbound W3C carrier when the Agent bootstrap provides
   * it. Keep the trace-id-only injection as a compatibility fallback for
   * isolated consumers and older tests.
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {unknown} [bodyTrace]
   * @returns {{ traceId: string, parentSpanId: string|null, traceFlags: string|null, traceState: string|null }}
   */
  function resolveTraceContext(req, bodyTrace) {
    if (typeof deps.resolveTraceContext === 'function') {
      const resolved = deps.resolveTraceContext(req, bodyTrace);
      if (resolved && typeof resolved.traceId === 'string') {
        return {
          traceId: resolved.traceId,
          parentSpanId:
            typeof resolved.parentSpanId === 'string'
              ? resolved.parentSpanId
              : null,
          traceFlags:
            typeof resolved.traceFlags === 'string'
              ? resolved.traceFlags
              : null,
          traceState:
            typeof resolved.traceState === 'string'
              ? resolved.traceState
              : null,
        };
      }
    }
    const traceId = deps.resolveTraceId(req, bodyTrace);
    return {
      traceId,
      parentSpanId: null,
      traceFlags: null,
      traceState: null,
    };
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {URL} parsedUrl
   * @returns {Promise<boolean>}
   */
  async function handle(req, res, parsedUrl) {
    const path = parsedUrl.pathname || '/';

    // ── Artifact download (capability token) ────────────────
    if (req.method === 'GET' && path === '/a2a/artifacts/download') {
      await handleArtifactDownload(req, res, parsedUrl);
      return true;
    }

    // ── Agent Card ──────────────────────────────────────────
    if (req.method === 'GET' && path === '/.well-known/agent-card.json') {
      try {
        const base = resolvePublicBaseUrl(req, {
          publicBaseUrl: deps.publicBaseUrl,
          deploymentEnv: deps.deploymentEnv,
          allowDevHostFallback: deps.allowDevHostFallback,
        });
        deps.json(
          res,
          200,
          buildAgentCard({
            rpcPath: '/a2a',
            baseUrl: base,
            name: 'Pi Enterprise Agent',
            description:
              'Discover agent-specific cards at /a2a/agents/{agent_id}/.well-known/agent-card.json',
          }),
        );
      } catch (err) {
        const msg =
          err instanceof ValidationError
            ? err.message
            : 'Agent card base URL misconfigured';
        deps.json(res, 503, { error: msg, code: 'A2A_BASE_URL' });
      }
      return true;
    }

    // The root Agent Card describes a credential-routed gateway. The
    // authenticated credential supplies the concrete tenant Agent id.
    if (req.method === 'POST' && (path === '/a2a' || path === '/a2a/')) {
      await handleJsonRpc(req, res, null);
      return true;
    }

    {
      const m = path.match(
        /^\/a2a\/agents\/([^/]+)\/\.well-known\/agent-card\.json$/,
      );
      if (m && req.method === 'GET') {
        const agentId = decodeURIComponent(m[1]);
        if (!isUlid(agentId)) {
          deps.json(res, 404, { error: 'Agent not found' });
          return true;
        }
        let meta = null;
        if (typeof deps.resolveAgentMeta === 'function') {
          try {
            meta = await deps.resolveAgentMeta(agentId);
          } catch {
            meta = null;
          }
        }
        // Valid ULID without catalog meta → 404 (no phantom cards).
        if (!meta) {
          deps.json(res, 404, { error: 'Agent not found' });
          return true;
        }
        try {
          const base = resolvePublicBaseUrl(req, {
            publicBaseUrl: deps.publicBaseUrl,
            deploymentEnv: deps.deploymentEnv,
            allowDevHostFallback: deps.allowDevHostFallback,
          });
          deps.json(
            res,
            200,
            buildAgentCard({
              agentId,
              baseUrl: base,
              name: meta.name,
              description: meta.description,
            }),
          );
        } catch (err) {
          const msg =
            err instanceof ValidationError
              ? err.message
              : 'Agent card base URL misconfigured';
          deps.json(res, 503, { error: msg, code: 'A2A_BASE_URL' });
        }
        return true;
      }
    }

    // ── JSON-RPC ────────────────────────────────────────────
    {
      const m = path.match(/^\/a2a\/agents\/([^/]+)$/);
      if (m && req.method === 'POST') {
        const agentId = decodeURIComponent(m[1]);
        if (!isUlid(agentId)) {
          deps.json(res, 404, { error: 'Agent not found' });
          return true;
        }
        await handleJsonRpc(req, res, agentId);
        return true;
      }
    }

    return false;
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {URL} parsedUrl
   */
  async function handleArtifactDownload(req, res, parsedUrl) {
    // Fail closed: never advertise/serve a "download" that returns metadata JSON.
    // Byte streaming is available only through the owner-scoped internal path.
    const streamer = deps.streamArtifactBytes;
    if (typeof streamer !== 'function') {
      deps.json(res, 503, {
        error: 'Artifact byte download is not available on this service',
        code: 'A2A_DOWNLOAD_BYTES_UNAVAILABLE',
      });
      return;
    }

    const token = parsedUrl.searchParams.get('token') || '';
    const secret = deps.artifactDownloadSecret;
    if (!secret) {
      deps.json(res, 503, {
        error: 'Artifact download not configured',
        code: 'A2A_DOWNLOAD_DISABLED',
      });
      return;
    }

    const authHeader =
      req.headers.authorization || req.headers.Authorization || '';
    let principal = null;
    try {
      principal = await deps.credentialService.authenticate(authHeader, {
        requiredScope: A2A_SCOPES.ARTIFACT_READ,
      });
    } catch {
      deps.json(res, 401, { error: 'Unauthorized', code: 'A2A_AUTH' });
      return;
    }

    let claims;
    try {
      claims = verifyArtifactDownloadToken(token, secret);
    } catch {
      deps.json(res, 403, { error: 'Invalid or expired download token' });
      return;
    }

    if (
      claims.orgId !== principal.orgId ||
      claims.clientId !== principal.clientId
    ) {
      deps.json(res, 403, { error: 'Download token ownership mismatch' });
      return;
    }

    if (typeof deps.taskService.resolveOwnedTask !== 'function') {
      deps.json(res, 503, { error: 'Download authority unavailable' });
      return;
    }
    let mapping;
    try {
      mapping = await deps.taskService.resolveOwnedTask(
        principal,
        claims.taskId,
      );
    } catch {
      deps.json(res, 404, { error: 'Not found' });
      return;
    }
    if (mapping.a2aTaskId !== claims.taskId) {
      deps.json(res, 404, { error: 'Not found' });
      return;
    }

    if (!deps.createRepositories) {
      deps.json(res, 503, { error: 'Artifact store unavailable' });
      return;
    }
    const repos = deps.createRepositories(deps.db);
    if (!repos.artifacts?.getById) {
      deps.json(res, 503, { error: 'Artifact store unavailable' });
      return;
    }
    const art = await repos.artifacts.getById(claims.artifactId, {
      orgId: principal.orgId,
      userId: principal.serviceUserId,
    });
    if (!art || art.runId !== mapping.runId) {
      deps.json(res, 404, { error: 'Not found' });
      return;
    }
    if (!hasScope(principal.scopes, A2A_SCOPES.ARTIFACT_READ)) {
      deps.json(res, 403, { error: 'Insufficient scope' });
      return;
    }

    const traceContext = resolveTraceContext(req);
    const traceId = traceContext.traceId;
    res.setHeader('X-Trace-Id', traceId);

    // Artifact byte access is an auditable A2A operation. Keep this check
    // before sending headers or bytes so an unavailable audit store fails
    // closed instead of producing an untraceable delivery.
    if (typeof deps.taskService.auditArtifactDownload === 'function') {
      try {
        await deps.taskService.auditArtifactDownload({
          principal,
          agentId: principal.agentId,
          taskId: mapping.a2aTaskId,
          runId: mapping.runId,
          artifactId: art.artifactId,
          traceId,
        });
      } catch {
        deps.json(res, 503, {
          error: 'Artifact download audit unavailable',
          code: 'A2A_AUDIT_UNAVAILABLE',
        });
        return;
      }
    }

    // Stream real bytes only — never relativePath on the wire.
    let streamResult;
    try {
      streamResult = await streamer({
        principal,
        claims,
        mapping,
        traceId,
        traceState: traceContext.traceState,
        artifact: {
          artifactId: art.artifactId,
          mimeType: art.mimeType,
          sizeBytes: art.sizeBytes,
          sha256: art.sha256,
          displayName: art.displayName,
          // relativePath intentionally not passed to streamer contract
        },
        req,
      });
    } catch {
      deps.json(res, 502, {
        error: 'Artifact byte source failed',
        code: 'A2A_DOWNLOAD_UPSTREAM',
      });
      return;
    }

    if (!streamResult?.body) {
      deps.json(res, 503, {
        error: 'Artifact byte download is not available',
        code: 'A2A_DOWNLOAD_BYTES_UNAVAILABLE',
      });
      return;
    }

    const contentTypeRaw =
      streamResult.contentType || art.mimeType || 'application/octet-stream';
    const safeType =
      /^(text\/html|application\/xhtml\+xml|image\/svg\+xml)/i.test(
        String(contentTypeRaw),
      )
        ? 'application/octet-stream'
        : String(contentTypeRaw);

    const headers = {
      'Content-Type': safeType,
      'Content-Disposition':
        streamResult.contentDisposition ||
        `attachment; filename="${String(art.displayName || art.artifactId).replace(/["\r\n]/g, '_')}"`,
      'X-Content-Type-Options': 'nosniff',
      'X-Artifact-Id': art.artifactId,
    };
    if (streamResult.contentLength != null && streamResult.contentLength !== '') {
      headers['Content-Length'] = String(streamResult.contentLength);
    } else if (art.sizeBytes != null) {
      headers['Content-Length'] = String(art.sizeBytes);
    }
    if (streamResult.sha256 || art.sha256) {
      headers['X-Artifact-Sha256'] = String(streamResult.sha256 || art.sha256);
    }

    res.writeHead(200, headers);

    let aborted = false;
    const onClose = () => {
      aborted = true;
      try {
        streamResult.body?.cancel?.();
      } catch {
        /* ignore */
      }
    };
    req.on('close', onClose);

    try {
      for await (const chunk of streamResult.body) {
        if (aborted || res.writableEnded || res.destroyed) break;
        const ok = res.write(chunk);
        if (ok === false) {
          await new Promise((resolve) => {
            const done = () => {
              res.off('drain', done);
              res.off('close', done);
              resolve(undefined);
            };
            res.once('drain', done);
            res.once('close', done);
          });
        }
      }
    } catch {
      // Client/upstream abort mid-stream — end quietly.
    } finally {
      req.off('close', onClose);
      if (!res.writableEnded && !res.destroyed) {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
    }
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {string | null} requestedAgentId
   */
  async function handleJsonRpc(req, res, requestedAgentId) {
    const raw = await deps.readBody(req);
    let body;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      deps.json(res, 200, jsonRpcError(null, { ...JSON_RPC_ERROR.PARSE }));
      return;
    }

    const parsed = parseJsonRpcRequest(body);
    if (!parsed.ok) {
      deps.json(res, 200, jsonRpcError(parsed.id, parsed.error));
      return;
    }

    const { id: rpcId, method, params } = parsed;
    const authHeader =
      req.headers.authorization || req.headers.Authorization || '';

    /** @type {object} */
    let principal;
    try {
      principal = await deps.credentialService.authenticate(authHeader, {
        agentId: requestedAgentId,
        requiredScope: requiredScopeForMethod(method),
      });
    } catch (err) {
      if (err instanceof A2aAuthError) {
        const status = err.code === 'A2A_AUTH_SCOPE' ? 403 : 401;
        res.writeHead(status, {
          'Content-Type': 'application/json; charset=utf-8',
          'WWW-Authenticate': 'Bearer',
        });
        res.end(
          JSON.stringify(
            jsonRpcError(rpcId, {
              ...A2A_RPC_ERROR.AUTH,
              data: { code: err.code },
            }),
          ),
        );
        return;
      }
      deps.json(res, 200, jsonRpcError(rpcId, { ...JSON_RPC_ERROR.INTERNAL }));
      return;
    }

    const agentId = requestedAgentId || principal.agentId;
    if (!isUlid(agentId)) {
      deps.json(res, 200, jsonRpcError(rpcId, { ...JSON_RPC_ERROR.INTERNAL }));
      return;
    }

    const bodyTrace =
      params?.metadata &&
      typeof params.metadata === 'object' &&
      /** @type {any} */ (params.metadata).traceId;
    const traceContext = resolveTraceContext(req, bodyTrace);
    const traceId = traceContext.traceId;

    res.setHeader('X-Trace-Id', traceId);
    res.setHeader('X-Caller-Type', 'a2a');
    res.setHeader('X-Caller-Id', principal.clientId);

    try {
      switch (method) {
        case A2A_METHODS.SEND_MESSAGE: {
          // Fail INVALID_PARAMS early if no stable key (also enforced in service).
          try {
            requireStableIdempotencyKey({
              messageId:
                params?.message && typeof params.message === 'object'
                  ? /** @type {any} */ (params.message).messageId ||
                    /** @type {any} */ (params.message).message_id
                  : params?.messageId,
              idempotencyKey:
                req.headers['idempotency-key'] ||
                req.headers['Idempotency-Key'] ||
                null,
            });
          } catch (err) {
            if (err instanceof ValidationError) {
              deps.json(
                res,
                200,
                jsonRpcError(rpcId, {
                  ...JSON_RPC_ERROR.INVALID_PARAMS,
                  data: { reason: err.message },
                }),
              );
              return;
            }
            throw err;
          }
          const task = await deps.taskService.sendMessage({
            principal,
            agentId,
            params,
            traceId,
            traceState: traceContext.traceState,
            traceFlags: traceContext.traceFlags,
            spanId: traceContext.parentSpanId,
            method: 'SendMessage',
            idempotencyKey:
              req.headers['idempotency-key'] ||
              req.headers['Idempotency-Key'] ||
              null,
          });
          deps.json(res, 200, jsonRpcSuccess(rpcId, task));
          return;
        }
        case A2A_METHODS.GET_TASK: {
          const taskId = extractTaskId(params);
          const task = await deps.taskService.getTask({
            principal,
            agentId,
            taskId,
            historyLength: params.historyLength,
            method: 'GetTask',
            traceId,
            traceState: traceContext.traceState,
            traceFlags: traceContext.traceFlags,
            spanId: traceContext.parentSpanId,
          });
          deps.json(res, 200, jsonRpcSuccess(rpcId, task));
          return;
        }
        case A2A_METHODS.CANCEL_TASK: {
          const taskId = extractTaskId(params);
          const task = await deps.taskService.cancelTask({
            principal,
            agentId,
            taskId,
            reason: typeof params.reason === 'string' ? params.reason : null,
            method: 'CancelTask',
            traceId,
            traceState: traceContext.traceState,
            spanId: traceContext.parentSpanId,
          });
          deps.json(res, 200, jsonRpcSuccess(rpcId, task));
          return;
        }
        case A2A_METHODS.SEND_STREAMING_MESSAGE: {
          try {
            requireStableIdempotencyKey({
              messageId:
                params?.message && typeof params.message === 'object'
                  ? /** @type {any} */ (params.message).messageId ||
                    /** @type {any} */ (params.message).message_id
                  : params?.messageId,
              idempotencyKey:
                req.headers['idempotency-key'] ||
                req.headers['Idempotency-Key'] ||
                null,
            });
          } catch (err) {
            if (err instanceof ValidationError) {
              deps.json(
                res,
                200,
                jsonRpcError(rpcId, {
                  ...JSON_RPC_ERROR.INVALID_PARAMS,
                  data: { reason: err.message },
                }),
              );
              return;
            }
            throw err;
          }
          const task = await deps.taskService.sendMessage({
            principal,
            agentId,
            params,
            traceId,
            traceState: traceContext.traceState,
            traceFlags: traceContext.traceFlags,
            spanId: traceContext.parentSpanId,
            method: 'SendStreamingMessage',
            idempotencyKey:
              req.headers['idempotency-key'] ||
              req.headers['Idempotency-Key'] ||
              null,
          });
          if (typeof deps.taskService.beginSubscribe === 'function') {
            await deps.taskService.beginSubscribe({
              principal,
              agentId,
              taskId: task.id,
              method: 'SendStreamingMessage',
              traceId,
              traceState: traceContext.traceState,
              spanId: traceContext.parentSpanId,
            });
          }
          await openSseStream(req, res, {
            principal,
            agentId,
            taskId: task.id,
            rpcId,
            afterSequence: 0,
            includeInitialTask: true,
            method: 'SendStreamingMessage',
            traceId,
            traceState: traceContext.traceState,
            spanId: traceContext.parentSpanId,
          });
          return;
        }
        case A2A_METHODS.SUBSCRIBE_TO_TASK: {
          const taskId = extractTaskId(params);
          if (typeof deps.taskService.beginSubscribe === 'function') {
            await deps.taskService.beginSubscribe({
              principal,
              agentId,
              taskId,
              method: 'SubscribeToTask',
              traceId,
              traceState: traceContext.traceState,
              spanId: traceContext.parentSpanId,
            });
          } else {
            await deps.taskService.getTask({
              principal,
              agentId,
              taskId,
              method: 'SubscribeToTask',
              traceId,
              traceState: traceContext.traceState,
              spanId: traceContext.parentSpanId,
            });
          }
          const afterSequence = Math.max(
            0,
            Number(params.afterSequence ?? params.after_sequence ?? 0) || 0,
          );
          const lastEventIdHeader = req.headers['last-event-id'];
          const lastEventId =
            typeof lastEventIdHeader === 'string' && lastEventIdHeader.trim()
              ? lastEventIdHeader.trim()
              : typeof params.lastEventId === 'string'
                ? params.lastEventId
                : null;
          await openSseStream(req, res, {
            principal,
            agentId,
            taskId,
            rpcId,
            afterSequence,
            lastEventId,
            includeInitialTask: true,
            method: 'SubscribeToTask',
            traceId,
            traceState: traceContext.traceState,
            spanId: traceContext.parentSpanId,
          });
          return;
        }
        default:
          deps.json(
            res,
            200,
            jsonRpcError(rpcId, { ...JSON_RPC_ERROR.METHOD_NOT_FOUND }),
          );
      }
    } catch (err) {
      const mapped = mapA2aErrorToRpc(err);
      deps.json(res, 200, jsonRpcError(rpcId, mapped));
    }
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {object} streamInput
   */
  async function openSseStream(req, res, streamInput) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    let closed = false;
    const ac = new AbortController();
    const onClose = () => {
      closed = true;
      try {
        ac.abort();
      } catch {
        /* ignore */
      }
    };
    req.on('close', onClose);
    res.on('close', onClose);
    res.on('error', onClose);

    const writeChunk = (chunk) => {
      if (closed || res.writableEnded || res.destroyed) return false;
      try {
        return res.write(chunk);
      } catch {
        closed = true;
        return false;
      }
    };

    const waitDrain = () =>
      waitForWritableResume({
        stream: res,
        signal: ac.signal,
        isClosed: () => closed || res.writableEnded || res.destroyed,
      });

    let outcome = 'completed';
    try {
      await deps.streamService.openTaskStream(
        {
          principal: streamInput.principal,
          agentId: streamInput.agentId,
          taskId: streamInput.taskId,
          rpcId: streamInput.rpcId,
          afterSequence: streamInput.afterSequence,
          lastEventId: streamInput.lastEventId,
          includeInitialTask: streamInput.includeInitialTask !== false,
        },
        {
          write: writeChunk,
          waitDrain,
          stream: res,
          isClosed: () => closed || res.writableEnded || res.destroyed,
          signal: ac.signal,
        },
      );
      if (closed || ac.signal.aborted) outcome = 'disconnect';
    } catch {
      outcome = 'error';
    } finally {
      if (typeof deps.taskService.auditStreamEnd === 'function') {
        try {
          await deps.taskService.auditStreamEnd({
            principal: streamInput.principal,
            agentId: streamInput.agentId,
            taskId: streamInput.taskId,
            method: streamInput.method,
            traceId: streamInput.traceId,
            traceState: streamInput.traceState,
            spanId: streamInput.spanId,
            outcome,
          });
        } catch {
          /* stream already open */
        }
      }
      if (!res.writableEnded && !res.destroyed) {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
      req.off('close', onClose);
      res.off('close', onClose);
      res.off('error', onClose);
    }
  }

  return { handle };
}

function requiredScopeForMethod(method) {
  switch (method) {
    case A2A_METHODS.SEND_MESSAGE:
    case A2A_METHODS.SEND_STREAMING_MESSAGE:
      return A2A_SCOPES.INVOKE;
    case A2A_METHODS.GET_TASK:
    case A2A_METHODS.SUBSCRIBE_TO_TASK:
      return A2A_SCOPES.READ;
    case A2A_METHODS.CANCEL_TASK:
      return A2A_SCOPES.CANCEL;
    default:
      return A2A_SCOPES.READ;
  }
}

function extractTaskId(params) {
  const id =
    params?.id ??
    params?.taskId ??
    params?.task_id ??
    (params?.task && typeof params.task === 'object'
      ? /** @type {any} */ (params.task).id
      : null);
  if (typeof id !== 'string' || !id.trim()) {
    throw new ValidationError('params.id (task id) is required');
  }
  return id.trim();
}

/**
 * @param {unknown} err
 */
export function mapA2aErrorToRpc(err) {
  if (err instanceof A2aTaskError && err.rpc) {
    return {
      code: err.rpc.code,
      message: err.rpc.message,
      data: { code: err.code },
    };
  }
  if (err instanceof A2aAuditError) {
    return {
      ...JSON_RPC_ERROR.INTERNAL,
      data: { code: err.code },
    };
  }
  if (err instanceof A2aAuthError) {
    return {
      ...A2A_RPC_ERROR.AUTH,
      data: { code: err.code },
    };
  }
  if (err instanceof ValidationError) {
    return {
      ...JSON_RPC_ERROR.INVALID_PARAMS,
      data: { reason: err.message, code: err.code },
    };
  }
  const code = /** @type {{ code?: string }} */ (err)?.code;
  if (code === 'NOT_FOUND') {
    return { ...A2A_RPC_ERROR.TASK_NOT_FOUND };
  }
  return { ...JSON_RPC_ERROR.INTERNAL };
}
