/**
 * Agent → exec 的**审核面** HMAC 客户端（design `agent-output-review.md` §6.2）。
 *
 * 为什么不复用 `ExecRpcClient`：那个客户端绑的是**一次 Run**（信封带 fenceToken、
 * claims 带 run_id，exec 侧按 ACTIVE AgentSession + fence 校验）。审核动作发生在
 * Run 之外——审核员在 Run 结束很久之后领取、修订、决定，那时没有任何活跃 fence。
 * 硬塞进 run 信封只会让「用哪个 run 的 fence」变成一个猜出来的值。
 *
 * 所以这里是独立传输：`/internal/v1/review/*` 这一族在 `contract/src/hmac.ts` 的
 * `HTU_BINDINGS` 里登记为 `allowNullRun`，claims 的 `run_id` 与
 * `execution_fence_token` 显式为 `null`（信封里的 `fenceToken` 取 0，只满足信封
 * 形状校验，不参与任何判定）。scope / tool_name 由同一张表给出，两侧一致。
 *
 * 归属只走**已校验的信封**（`orgId`/`userId` 由调用方从审核任务行取，不是请求体
 * 里用户可控的字段），exec 侧再按 org 作用域判一次。
 */

import { createHash } from 'node:crypto';

import { issueInternalToken, validateInternalHmacKeyring } from '@dsh/contract/hmac.js';
import { normalizeBaseUrl } from './transport-base-url.js';
import { createTraceHeaders } from './trace-context.js';

export const REVIEW_SCOPE = 'sandbox.review';
export const REVIEW_TOOL_NAME = 'review';
export const DEFAULT_REVIEW_TIMEOUT_MS = 30_000;

export const REVIEW_HTU = Object.freeze({
  snapshot: '/internal/v1/review/artifacts/snapshot',
  get: '/internal/v1/review/artifacts/get',
  revision: '/internal/v1/review/artifacts/revision',
  visibility: '/internal/v1/review/artifacts/visibility',
  import: '/internal/v1/review/artifacts/import',
});

export interface ReviewIdentity {
  readonly orgId: string;
  readonly userId: string;
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly agentSessionId: string;
  readonly sandboxSessionId: string;
  readonly traceId: string;
}

export class InternalReviewError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly retryable: boolean;

  constructor(
    code: string,
    message: string,
    options: { httpStatus?: number; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = 'InternalReviewError';
    this.code = code;
    this.httpStatus = options.httpStatus ?? 502;
    this.retryable = options.retryable === true;
  }
}

function sha256Hex(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertNonEmpty(value: unknown, field: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new InternalReviewError('REVIEW_CLIENT_INPUT_INVALID', `${field} is required`, { httpStatus: 500 });
  return text;
}

/**
 * 一次审核面 RPC。
 *
 * @param htu `/internal/v1/review/...` 之一（决定 scope/tool_name/签名绑定）。
 */
export function createInternalReviewTransport(options: {
  baseUrl: string;
  /** HMAC 密钥环（对象或 JSON 字符串）；形状由 contract 的校验器负责。 */
  keyring: any;
  activeKid: string;
  allowInsecureHttp?: boolean;
  fetchImpl?: typeof fetch;
  clock?: () => number;
  timeoutMs?: number;
} ) {
  const baseUrl = normalizeBaseUrl(options?.baseUrl, {
    allowInsecureHttp: options?.allowInsecureHttp === true,
  });
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('internal review transport requires fetchImpl');
  }
  validateInternalHmacKeyring(options.keyring, options.activeKid);
  const timeoutMs = options.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('internal review transport timeoutMs must be a positive safe integer');
  }

  async function post<T>(
    htu: string,
    payload: Record<string, unknown>,
    identity: ReviewIdentity,
  ): Promise<T> {
    const envelope = {
      // 审核面不属于任何 Run：requestId 只用于日志关联，fenceToken 取 0 满足信封
      // 形状（exec 侧不读它做判定）。
      requestId: `${identity.agentSessionId}:${htu.split('/').pop()}`,
      workspaceId: assertNonEmpty(identity.workspaceId, 'identity.workspaceId'),
      orgId: assertNonEmpty(identity.orgId, 'identity.orgId'),
      userId: assertNonEmpty(identity.userId, 'identity.userId'),
      fenceToken: 0,
      sessionId: identity.sandboxSessionId || identity.workspaceId,
    };
    const body = Buffer.from(JSON.stringify({ envelope, payload }), 'utf8');
    const bodySha256 = sha256Hex(body);
    const operationId = `${identity.agentSessionId}:${htu.split('/').pop()}`;
    const token = issueInternalToken({
      keyring: options.keyring,
      activeKid: options.activeKid,
      clock: options.clock,
      claims: {
        org_id: envelope.orgId,
        user_id: envelope.userId,
        conversation_id: assertNonEmpty(identity.conversationId, 'identity.conversationId'),
        agent_session_id: assertNonEmpty(identity.agentSessionId, 'identity.agentSessionId'),
        sandbox_session_id: assertNonEmpty(identity.sandboxSessionId, 'identity.sandboxSessionId'),
        // 无 Run 路线：两者必须**同时**为 null，否则 `isPreRunProfile` 不成立。
        run_id: null,
        tool_execution_id: operationId,
        tool_call_id: operationId,
        tool_name: REVIEW_TOOL_NAME,
        scope: [REVIEW_SCOPE],
        request_hash: bodySha256,
        execution_fence_token: null,
        trace_id: assertNonEmpty(identity.traceId, 'identity.traceId'),
        htm: 'POST',
        htu,
        body_sha256: bodySha256,
      },
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${htu}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          ...createTraceHeaders(identity.traceId),
        },
        body,
        signal: controller.signal,
      });
    } catch (cause) {
      throw new InternalReviewError(
        'SANDBOX_REVIEW_UNAVAILABLE',
        'Sandbox review plane unavailable',
        { retryable: true },
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text().catch(() => '');
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok || parsed?.['ok'] !== true) {
      const error = (parsed?.['error'] ?? {}) as Record<string, unknown>;
      const code = typeof error['code'] === 'string' ? error['code'] : 'SANDBOX_REVIEW_FAILED';
      throw new InternalReviewError(code, `Sandbox review request failed (${response.status})`, {
        httpStatus: response.status,
        retryable: response.status >= 500,
      });
    }
    return (parsed['data'] ?? {}) as T;
  }

  return Object.freeze({
    /** 附件快照：复制成不可变产物，`withdrawn`（永远不对发起人可见）。 */
    async snapshot(
      input: { sourcePath: string; name?: string | null; mimeType?: string | null },
      identity: ReviewIdentity,
    ): Promise<{ artifactId: string; name: string; mimeType: string; sha256: string; size: number }> {
      return await post(REVIEW_HTU.snapshot, {
        sourcePath: input.sourcePath,
        ...(input.name ? { name: input.name } : {}),
        ...(input.mimeType ? { mimeType: input.mimeType } : {}),
      }, identity);
    },

    /** 按 id 读取任一版本（org 作用域、不看可见性），含字节。 */
    async getArtifact(
      input: { artifactId: string },
      identity: ReviewIdentity,
    ): Promise<{
      artifactId: string; name: string; mimeType: string; sha256: string; size: number;
      visibility: string; revisionOf: string | null; bytes: Buffer;
    }> {
      const data = await post<Record<string, unknown>>(REVIEW_HTU.get, {
        artifactId: input.artifactId,
      }, identity);
      const raw = typeof data['bytes'] === 'string' ? data['bytes'] : '';
      const bytes = Buffer.from(raw, 'base64');
      // 与 exec 的 `decodeBase64` 同一条纪律：Node 的 base64 解码很宽松，
      // 重新编码比对才能把「传了个不是 base64 的东西」变成错误而不是空文件。
      if (bytes.toString('base64').replace(/=+$/, '') !== raw.replace(/=+$/, '')) {
        throw new InternalReviewError('SANDBOX_RESPONSE_INVALID', 'artifact bytes are not base64', {
          retryable: true,
        });
      }
      return {
        artifactId: String(data['artifactId'] ?? input.artifactId),
        name: String(data['name'] ?? ''),
        mimeType: String(data['mimeType'] ?? 'application/octet-stream'),
        sha256: String(data['sha256'] ?? ''),
        size: Number(data['size'] ?? 0) || 0,
        visibility: String(data['visibility'] ?? ''),
        revisionOf: data['revisionOf'] == null ? null : String(data['revisionOf']),
        bytes,
      };
    },

    /** 审核员的修订上传：新产物 + `revision_of` 链，恒 `held`。 */
    async submitRevision(
      input: { originalArtifactId: string; bytes: Uint8Array; name?: string | null; mimeType?: string | null },
      identity: ReviewIdentity,
    ): Promise<{ artifactId: string; name: string; mimeType: string; sha256: string; size: number; revisionOf: string | null }> {
      const data = await post<Record<string, unknown>>(REVIEW_HTU.revision, {
        originalArtifactId: input.originalArtifactId,
        bytesBase64: Buffer.from(input.bytes).toString('base64'),
        ...(input.name ? { name: input.name } : {}),
        ...(input.mimeType ? { mimeType: input.mimeType } : {}),
      }, identity);
      return {
        artifactId: String(data['artifactId'] ?? ''),
        name: String(data['name'] ?? ''),
        mimeType: String(data['mimeType'] ?? 'application/octet-stream'),
        sha256: String(data['sha256'] ?? ''),
        size: Number(data['size'] ?? 0) || 0,
        revisionOf: data['revisionOf'] == null ? null : String(data['revisionOf']),
      };
    },

    /** 状态变更：`held` → `released` / `withdrawn`，单事务、幂等。 */
    async applyVisibilities(
      input: { updates: readonly { artifactId: string; visibility: 'released' | 'withdrawn' }[] },
      identity: ReviewIdentity,
    ): Promise<{ changed: number }> {
      const data = await post<Record<string, unknown>>(REVIEW_HTU.visibility, {
        updates: input.updates,
      }, identity);
      return { changed: Number(data['changed'] ?? 0) || 0 };
    },

    /** 把修订版导入工作区的 `审核版/` 目录（§5.3 第 3 步）。 */
    async importRevision(
      input: { artifactId: string; targetPath: string },
      identity: ReviewIdentity,
    ): Promise<{ artifactId: string; path: string }> {
      const data = await post<Record<string, unknown>>(REVIEW_HTU.import, {
        artifactId: input.artifactId,
        targetPath: input.targetPath,
      }, identity);
      return {
        artifactId: String(data['artifactId'] ?? input.artifactId),
        path: String(data['path'] ?? input.targetPath),
      };
    },
  });
}

export type InternalReviewTransport = ReturnType<typeof createInternalReviewTransport>;
