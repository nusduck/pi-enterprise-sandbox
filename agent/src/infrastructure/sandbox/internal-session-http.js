/** Agent -> Sandbox HMAC transport for SandboxSession provisioning. */

import { createHash } from 'node:crypto';

import { assertUlid } from '../../domain/shared/ulid.js';
import { issueInternalToken } from './internal-hmac.js';
import { normalizeBaseUrl } from './internal-files-read-http.js';
import {
  assertW3cTraceId,
  createTraceHeaders,
  normalizeW3cTracestate,
} from './trace-context.js';

export const SESSION_ENSURE_HTU = '/internal/v1/sessions/ensure';
export const SESSION_ENSURE_SCOPE = 'sandbox.sessions.ensure';
export const SESSION_ENSURE_TOOL_NAME = 'session.ensure';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function assertPositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}

function assertTraceId(value) {
  return assertW3cTraceId(value);
}

/**
 * @param {{
 *   baseUrl: string,
 *   keyring: object|string,
 *   activeKid: string,
 *   allowInsecureHttp?: boolean,
 *   fetchImpl?: typeof fetch,
 *   clock?: () => number,
 *   timeoutMs?: number,
 *   spanRandomBytes?: (size: number) => Uint8Array,
 * }} options
 */
export function createInternalSessionProvisioner(options) {
  const baseUrl = normalizeBaseUrl(options?.baseUrl, {
    allowInsecureHttp: options?.allowInsecureHttp === true,
  });
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetchImpl must be a function');
  }
  const timeoutMs = options?.timeoutMs ?? 15_000;
  assertPositiveInteger(timeoutMs, 'timeoutMs');

  return {
    async ensure(input) {
      const hasRun = input?.runId != null || input?.executionFenceToken != null;
      if (hasRun && (input?.runId == null || input?.executionFenceToken == null)) {
        throw new Error('runId and executionFenceToken must be provided together');
      }
      const identity = {
        orgId: assertUlid(input?.orgId, 'orgId'),
        userId: assertUlid(input?.userId, 'userId'),
        conversationId: assertUlid(input?.conversationId, 'conversationId'),
        agentSessionId: assertUlid(input?.agentSessionId, 'agentSessionId'),
        sandboxSessionId: assertUlid(
          input?.sandboxSessionId,
          'sandboxSessionId',
        ),
        runId: hasRun ? assertUlid(input?.runId, 'runId') : null,
        workspaceId: assertUlid(input?.workspaceId, 'workspaceId'),
        executionFenceToken: hasRun
          ? assertPositiveInteger(
              input?.executionFenceToken,
              'executionFenceToken',
            )
          : null,
        traceId: assertTraceId(input?.traceId),
        traceState: normalizeW3cTracestate(input?.traceState),
      };
      const body = Buffer.from(
        JSON.stringify({ workspaceId: identity.workspaceId }),
        'utf8',
      );
      const bodySha256 = sha256(body);
      const operationId = `${identity.runId || identity.agentSessionId}:session.ensure`;
      const token = issueInternalToken({
        keyring: options.keyring,
        activeKid: options.activeKid,
        clock: options.clock,
        claims: {
          org_id: identity.orgId,
          user_id: identity.userId,
          conversation_id: identity.conversationId,
          agent_session_id: identity.agentSessionId,
          sandbox_session_id: identity.sandboxSessionId,
          run_id: identity.runId,
          tool_execution_id: operationId,
          tool_call_id: operationId,
          tool_name: SESSION_ENSURE_TOOL_NAME,
          scope: [SESSION_ENSURE_SCOPE],
          request_hash: bodySha256,
          execution_fence_token: identity.executionFenceToken,
          trace_id: identity.traceId,
          htm: 'POST',
          htu: SESSION_ENSURE_HTU,
          body_sha256: bodySha256,
        },
      });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetchImpl(`${baseUrl}${SESSION_ENSURE_HTU}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            'content-length': String(body.byteLength),
            ...createTraceHeaders(identity.traceId, {
              randomBytes: options.spanRandomBytes,
              traceState: identity.traceState,
            }),
          },
          body,
          signal: controller.signal,
        });
      } catch (error) {
        const wrapped = new Error('Sandbox session provisioning unavailable');
        wrapped.code = 'SANDBOX_SESSION_PROVISION_FAILED';
        wrapped.cause = error;
        throw wrapped;
      } finally {
        clearTimeout(timer);
      }
      const text = await response.text();
      if (!response.ok) {
        const error = new Error(
          `Sandbox session provisioning failed (status=${response.status})`,
        );
        error.code = 'SANDBOX_SESSION_PROVISION_FAILED';
        error.httpStatus = response.status;
        throw error;
      }
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error('Sandbox session provisioning returned invalid JSON');
      }
      if (
        payload?.sandboxSessionId !== identity.sandboxSessionId ||
        payload?.agentSessionId !== identity.agentSessionId ||
        payload?.workspaceId !== identity.workspaceId ||
        payload?.status !== 'ACTIVE'
      ) {
        throw new Error('Sandbox session provisioning response binding mismatch');
      }
      return payload;
    },
  };
}
