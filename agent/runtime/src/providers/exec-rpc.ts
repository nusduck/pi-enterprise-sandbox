/**
 * Exec RPC 共享客户端——Agent 侧唯一与 exec 内部面说话的地方。
 *
 * 为什么单独一层：`remote-fs/shell/jobs` 三个 provider 都要做同一套事——
 * 组信封、算 body_sha256、签 HMAC、fetch、把 WireError 翻回类型化 Error、
 * 脱敏。把这些抄三遍会重演 `_shared.md §7` 的“同一件事两处各算一遍”。
 * 这一层是唯一做 fetch + 签名 + 响应解析的地方，三个 provider 只拼路径与 payload。
 *
 * 本机零文件/进程操作；所有 I/O 都在 exec 侧。`resolve()` 异步也因此成立
 * （对齐 `dsh-fs` 注释“远程后端可能需要 I/O”）。
 *
 * 错误处理：任何跨边界抛出物都经 `toWireError` 无条件脱敏（硬约束 #1），
 * `physicalRoots` 必传无默认值——漏传直接编译失败，不静默放行。
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { FsError } from '@deepseek-ai/dsh-fs';
import { ContractError, toWireError } from '@pi/contract/errors.js';
import type { RpcEnvelope } from '@pi/contract/envelope.js';
import type { WireError } from '@pi/contract/errors.js';
import { issueInternalToken } from '@pi/contract/hmac.js';
import type { InternalHmacKeyringInput } from '@pi/contract/hmac.js';

/** 客户端必需的身份与签名材料——由 `runtime` 启动时从服务端环境变量注入，不落盘。 */
export interface ExecRpcConfig {
  readonly baseUrl: string;
  readonly keyring: InternalHmacKeyringInput;
  readonly activeKid: string;
  /** 每个请求的 envelope 要填的租户上下文；fenceToken 单调递增，由调用方每次现取。 */
  readonly orgId: string;
  readonly userId: string;
  readonly workspaceId: string;
  /** 当前 fence，未设置时传 0（pre-run session.ensure 特例由服务端校验）。 */
  readonly fenceToken: number;
  /** 仅用于错误脱敏的物理根列表；必填无默认值（fail-closed）。 */
  readonly physicalRoots: readonly string[];
  /** 单次 fetch 超时毫秒，默认 15000。 */
  readonly timeoutMs?: number | undefined;
  /** 可注入的 fetch，便于 macOS 无 exec 的内存替身测试。 */
  readonly fetchImpl?: typeof fetch | undefined;
}

function assertNonEmpty(value: string, field: string): void {
  if (value.length === 0) throw new ContractError('ENVELOPE_INVALID', `${field} must be non-empty`);
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function randomHex(len: number): string {
  const bytes = new Uint8Array(len);
  // 同步随机仅用于测试桩 claim 的 tool_call_id 等幂等键，非安全关键熵
  for (let i = 0; i < len; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

const execRpcAls = new AsyncLocalStorage<ExecRpcConfig>();

/** 按 Run 覆盖租户/围栏；Cordis 插件在 boot 时用环境占位构造，prompt 时绑定真值。 */
export function runWithExecRpc<T>(config: ExecRpcConfig, fn: () => T): T {
  return execRpcAls.run(config, fn);
}

export function currentExecRpc(fallback: ExecRpcConfig): ExecRpcConfig {
  return execRpcAls.getStore() ?? fallback;
}

/** 组合插件在 yaml `config: {}` 下从环境装配 HMAC；完整对象则原样使用。 */
export function readExecRpcFromEnv(env: NodeJS.ProcessEnv = process.env): ExecRpcConfig {
  const keyring = String(env['SANDBOX_INTERNAL_HMAC_KEYRING'] ?? '').trim();
  const activeKid = String(env['SANDBOX_INTERNAL_HMAC_ACTIVE_KID'] ?? '').trim();
  if (keyring.length === 0 || activeKid.length === 0) {
    throw new Error('boot: SANDBOX_INTERNAL_HMAC_KEYRING and SANDBOX_INTERNAL_HMAC_ACTIVE_KID are required');
  }
  return {
    baseUrl: String(env['SANDBOX_BASE_URL'] ?? 'http://sandbox:8081').replace(/\/+$/, ''),
    keyring,
    activeKid,
    orgId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    userId: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
    workspaceId: '01ARZ3NDEKTSV4RRFFQ69G5FAX',
    fenceToken: 0,
    physicalRoots: [
      String(env['SANDBOX_WORKSPACES_ROOT'] ?? '/var/sandbox/workspaces'),
      String(env['SANDBOX_TEMP_ROOT'] ?? '/var/sandbox/tmp'),
    ],
  };
}

export function resolveExecRpcConfig(
  partial?: Partial<ExecRpcConfig> | ExecRpcConfig,
): ExecRpcConfig {
  if (
    partial !== undefined &&
    typeof partial.baseUrl === 'string' &&
    partial.baseUrl.length > 0 &&
    partial.keyring != null &&
    typeof partial.activeKid === 'string' &&
    partial.activeKid.length > 0 &&
    Array.isArray(partial.physicalRoots) &&
    typeof partial.orgId === 'string' &&
    typeof partial.userId === 'string' &&
    typeof partial.workspaceId === 'string'
  ) {
    return partial as ExecRpcConfig;
  }
  return { ...readExecRpcFromEnv(), ...(partial ?? {}) } as ExecRpcConfig;
}

/** 把 WireError 翻回等待 `instanceof` 分支的强类型 Error。 */
export function fromWireError(wire: WireError): Error {
  const code = wire.code;
  if (
    code === 'FS_NOT_FOUND' ||
    code === 'FS_NOT_DIRECTORY' ||
    code === 'FS_NOT_TEXT' ||
    code === 'FS_NOT_REGULAR_FILE' ||
    code === 'FS_TOO_LARGE' ||
    code === 'FS_PERMISSION_DENIED' ||
    code === 'FS_SANDBOX_DENIED' ||
    code === 'FS_IO_ERROR' ||
    code === 'FS_STALE_VERSION' ||
    code === 'FS_NOT_OBSERVED' ||
    code === 'FS_AMBIGUOUS_EDIT' ||
    code === 'FS_EDIT_NOT_FOUND' ||
    code === 'FS_ABORTED'
  ) {
    return new FsError(wire.message, code);
  }
  if (
    code === 'AUTH_FAILED' ||
    code === 'ENVELOPE_INVALID' ||
    code === 'TENANT_MISMATCH' ||
    code === 'FENCE_EXPIRED' ||
    code === 'WORKSPACE_NOT_FOUND' ||
    code === 'INTERNAL_ERROR'
  ) {
    return new ContractError(code, wire.message);
  }
  return new ContractError('INTERNAL_ERROR', wire.message);
}

/** 用 `for await...of` 转发的异步迭代器守卫——错误在迭代时才抛，需二次包。 */
export async function* guardIterable<T>(
  iterable: AsyncIterable<T>,
  physicalRoots: readonly string[],
): AsyncIterable<T> {
  try {
    for await (const chunk of iterable) {
      yield chunk;
    }
  } catch (err: unknown) {
    // 无条件脱敏：任何类型抛出物都经 toWireError 三级兜底
    const wire = toWireError(err, { physicalRoots });
    throw fromWireError(wire);
  }
}

/** 共享的 fetch + HMAC 客户端。 */
export class ExecRpcClient {
  private baseUrl: string;
  private keyring: InternalHmacKeyringInput;
  private activeKid: string;

  constructor(private config: ExecRpcConfig) {
    assertNonEmpty(config.baseUrl, 'baseUrl');
    assertNonEmpty(config.activeKid, 'activeKid');
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.keyring = config.keyring;
    this.activeKid = config.activeKid;
  }

  /** 按 Run 重绑租户。boot 插件用环境占位构造，create() 必须换成这一 Run 的信封。 */
  rebind(config: ExecRpcConfig): void {
    assertNonEmpty(config.baseUrl, 'baseUrl');
    assertNonEmpty(config.activeKid, 'activeKid');
    this.config = config;
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.keyring = config.keyring;
    this.activeKid = config.activeKid;
  }

  activeConfig(): ExecRpcConfig {
    return currentExecRpc(this.config);
  }

  private envelope(): RpcEnvelope {
    const cfg = this.activeConfig();
    return {
      requestId: randomUUID(),
      workspaceId: cfg.workspaceId,
      orgId: cfg.orgId,
      userId: cfg.userId,
      fenceToken: cfg.fenceToken,
    };
  }

  /** POST /internal/v1/<path> 带信封与 HMAC。 */
  async post<TPayload, TData>(
    htu: string,
    payload: TPayload,
    physicalRoots: readonly string[],
  ): Promise<TData> {
    const envelope = this.envelope();
    const bodyObj = { envelope, payload };
    const bodyText = JSON.stringify(bodyObj);
    const bodyBytes = new TextEncoder().encode(bodyText);
    const bodySha = sha256Hex(bodyBytes);

    const token = this.issueToken(htu, bodySha, envelope);
    const url = `${this.baseUrl}${htu}`;
    const cfg = this.activeConfig();
    const timeoutMs = cfg.timeoutMs ?? this.config.timeoutMs ?? 15000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const fetchImpl: typeof fetch = cfg.fetchImpl ?? this.config.fetchImpl ?? globalThis.fetch;
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: bodyText,
        signal: controller.signal,
      });

      const text = await res.text();
      let json: unknown = null;
      try {
        json = text ? (JSON.parse(text) as unknown) : null;
      } catch {
        throw new ContractError('INTERNAL_ERROR', `exec returned non-JSON: ${text.slice(0, 500)}`);
      }

      const obj = json as Record<string, unknown> | null;
      if (!obj || typeof obj !== 'object') {
        throw new ContractError('INTERNAL_ERROR', 'exec returned non-object');
      }

      if (obj['ok'] === true) {
        return obj['data'] as TData;
      }

      const err = obj['error'] as WireError | undefined;
      if (err !== undefined && typeof err === 'object' && typeof (err as WireError).code === 'string') {
        throw fromWireError(err as WireError);
      }
      throw new ContractError('INTERNAL_ERROR', 'exec returned failure without WireError');
    } catch (err: unknown) {
      if (err instanceof FsError || err instanceof ContractError) throw err;
      // 网络/超时/JSON 解析等未分类错误：无条件脱敏后以 INTERNAL_ERROR 向外抛
      const wire = toWireError(err, { physicalRoots });
      throw fromWireError(wire);
    } finally {
      clearTimeout(timer);
    }
  }

  /** GET /internal/v1/fs/stream-text?envelope=...&target=... 带 HMAC。 */
  async getStream(
    htu: string,
    query: Record<string, string>,
    physicalRoots: readonly string[],
  ): Promise<AsyncIterable<string>> {
    const envelope = this.envelope();
    // GET 的 body 为空，body_sha256 为空串的 sha256
    const bodySha = sha256Hex(new Uint8Array(0));
    const token = this.issueToken(htu, bodySha, envelope);
    const url = new URL(`${this.baseUrl}${htu}`);
    // envelope 与业务 query 一并带上（base64url，便于 GET）
    url.searchParams.set('envelope', Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url'));
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

    const cfg = this.activeConfig();
    const timeoutMs = cfg.timeoutMs ?? this.config.timeoutMs ?? 15000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const fetchImpl: typeof fetch = cfg.fetchImpl ?? this.config.fetchImpl ?? globalThis.fetch;
      const res = await fetchImpl(url.toString(), {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '');
        // 尝试解析 WireError
        try {
          const j = JSON.parse(text) as Record<string, unknown>;
          const err = j['error'] as WireError | undefined;
          if (err !== undefined && typeof err.code === 'string') throw fromWireError(err);
        } catch (e) {
          if (e instanceof FsError || e instanceof ContractError) throw e;
        }
        throw new ContractError('INTERNAL_ERROR', `exec stream failed: ${res.status} ${text.slice(0, 500)}`);
      }

      // 将 ReadableStream 转为 AsyncIterable<string>（按 UTF-8 解码，已由 exec 侧保证 text）
      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      const iterable: AsyncIterable<string> = {
        [Symbol.asyncIterator](): AsyncIterator<string> {
          return {
            async next(): Promise<IteratorResult<string>> {
              const { done, value } = await reader.read();
              if (done) return { done: true, value: undefined as unknown as string };
              const chunk = decoder.decode(value, { stream: true });
              return { done: false, value: chunk };
            },
            async return(): Promise<IteratorResult<string>> {
              await reader.cancel().catch(() => undefined);
              return { done: true, value: undefined as unknown as string };
            },
          };
        },
      };

      return guardIterable(iterable, physicalRoots);
    } catch (err: unknown) {
      if (err instanceof FsError || err instanceof ContractError) throw err;
      const wire = toWireError(err, { physicalRoots });
      throw fromWireError(wire);
    } finally {
      clearTimeout(timer);
    }
  }

  private issueToken(htu: string, bodySha: string, envelope: RpcEnvelope): string {
    // 复用 contract/hmac 的严格 schema；此处用最小可用 claim 集合
    // conversation_id / sandbox_session_id 等在 pre-run 以外为必填，取 envelope 映射
    const conversationId = `conv-${envelope.workspaceId.slice(0, 12)}`;
    const sandboxSessionId = envelope.workspaceId;
    const agentSessionId = envelope.workspaceId;

    return issueInternalToken({
      keyring: this.keyring,
      activeKid: this.activeKid,
      claims: {
        org_id: envelope.orgId,
        user_id: envelope.userId,
        conversation_id: conversationId,
        agent_session_id: agentSessionId,
        sandbox_session_id: sandboxSessionId,
        run_id: envelope.requestId,
        tool_execution_id: `tool-${randomHex(4)}`,
        tool_call_id: `call-${randomHex(6)}`,
        tool_name: 'fs',
        scope: ['internal:fs'] as const,
        request_hash: sha256Hex(new TextEncoder().encode(`${htu}:${bodySha}`)),
        execution_fence_token: envelope.fenceToken,
        trace_id: envelope.requestId,
        htm: 'POST',
        htu,
        body_sha256: bodySha,
      },
    });
  }
}
