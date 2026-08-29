/**
 * facade 私有的窄桥 HTTP 客户端。移植自 `sandbox/mcp/sandbox_client.py`。
 *
 * 这条桥是 facade 唯一能碰到执行面的通道：它只认识 `/internal/mcp/v1/*` 这
 * 八条路由，且用与内部面 HMAC 不同的一枚 `SANDBOX_MCP_INTERNAL_TOKEN`。
 * facade 是对外暴露的进程，拿到它的 token 也够不到完整内部面——这是它值得
 * 单独部署的全部理由，重写时一条都不能少。
 *
 * ## Model Experience
 * 模型看到的是本文件映射出的稳定短句，而不是桥那边的原始异常文本。
 * 错误码表是**封闭**的：认识的码给可执行的指导（例如 FILE_NOT_FOUND 会告诉
 * 模型 context_id 要和之前的写入调用一致），不认识的码只保留码本身、文案退化
 * 成通用句，永远不转发上游异常文本。
 *
 * ## Known Limitations and Deferred Work
 * - 超时固定 310 秒，比执行面的 300 秒上限多 10 秒，让执行面自己的超时先触发。
 */
import type { McpSettings } from './settings.js';

/**
 * 桥的 ControlPlaneError 码 → 安全的、运维/LLM 可见的文案。
 * 保持封闭：绝不转发桥那边的原始异常文本。
 */
const BRIDGE_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  FILE_NOT_FOUND:
    'Workspace file not found for artifact submit. ' +
    'Use the same context_id as the write/execute call, and a relative source_path ' +
    'that exists in that workspace.',
  TOO_LARGE: 'File exceeds MCP max size for artifact submit',
  ARTIFACT_EXISTS: 'Artifact already exists',
  NOT_REGULAR_FILE: 'Artifact source must be a regular file',
  SYMLINK_REJECTED: 'Symlinks are not allowed as artifact sources',
  PATH_INVALID: 'Invalid artifact source_path',
  SOURCE_OPEN_FAILED: 'Unable to open artifact source file',
  SIZE_MISMATCH: 'Artifact snapshot failed integrity check',
};

export class SandboxBridgeError extends Error {
  readonly code: string | undefined;

  constructor(message: string, code?: string | undefined) {
    super(message);
    this.name = 'SandboxBridgeError';
    this.code = code;
  }
}

function isAsciiUpper(value: string): boolean {
  return /^[A-Z0-9_]+$/.test(value);
}

/**
 * 把桥的 HTTP 失败映射成稳定、不泄漏的客户端消息。
 *
 * 历史上每个 4xx/5xx 都变成 "Sandbox rejected the request"，低代码客户端
 * （Dify 等）把它显示成一个不透明的内部错误——尤其是 context_id 不匹配、
 * 或写入成功后 source_path 却不存在的时候。
 */
export async function safeBridgeError(response: Response): Promise<SandboxBridgeError> {
  if (response.status === 503) {
    return new SandboxBridgeError('Sandbox is temporarily unavailable', 'UNAVAILABLE');
  }

  let code: string | undefined;
  let message: string | undefined;
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    const detail = (body as Record<string, unknown>)['detail'];
    if (detail !== null && typeof detail === 'object' && !Array.isArray(detail)) {
      const rawCode = (detail as Record<string, unknown>)['code'];
      const rawMessage = (detail as Record<string, unknown>)['message'];
      if (typeof rawCode === 'string' && rawCode in BRIDGE_ERROR_MESSAGES) {
        code = rawCode;
        message = BRIDGE_ERROR_MESSAGES[rawCode];
      } else if (typeof rawCode === 'string' && isAsciiUpper(rawCode) && rawCode.length <= 64) {
        // 未知但格式良好的控制面码：保留码，文案用通用句。
        code = rawCode;
        message = 'Sandbox rejected the request';
      } else if (
        typeof rawMessage === 'string' &&
        Object.values(BRIDGE_ERROR_MESSAGES).includes(rawMessage)
      ) {
        message = rawMessage;
      }
    } else if (
      typeof detail === 'string' &&
      (detail === 'Invalid request' || detail === 'Sandbox operation failed')
    ) {
      message = detail;
    }
  }

  if (message === undefined) {
    if (response.status === 404) {
      message = BRIDGE_ERROR_MESSAGES['FILE_NOT_FOUND'] as string;
      code = code ?? 'FILE_NOT_FOUND';
    } else if (response.status === 413) {
      message = BRIDGE_ERROR_MESSAGES['TOO_LARGE'] as string;
      code = code ?? 'TOO_LARGE';
    } else if (response.status === 400) {
      message = 'Invalid request';
    } else {
      message = 'Sandbox rejected the request';
    }
  }

  return new SandboxBridgeError(message, code);
}

const BRIDGE_TIMEOUT_MS = 310_000;

export class SandboxBridgeClient {
  readonly #settings: McpSettings;
  readonly #fetch: typeof fetch;
  #started = false;

  constructor(settings: McpSettings, fetchImpl: typeof fetch = fetch) {
    this.#settings = settings;
    this.#fetch = fetchImpl;
  }

  start(): void {
    this.#started = true;
  }

  close(): void {
    this.#started = false;
  }

  get #headers(): Record<string, string> {
    return { authorization: `Bearer ${this.#settings.internalToken}` };
  }

  #url(path: string): string {
    return `${this.#settings.sandboxBaseUrl.replace(/\/+$/, '')}${path}`;
  }

  async post(path: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.#started) throw new SandboxBridgeError('Sandbox bridge is unavailable');
    let response: Response;
    try {
      response = await this.#fetch(this.#url(path), {
        method: 'POST',
        headers: { ...this.#headers, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
      });
    } catch {
      throw new SandboxBridgeError('Sandbox bridge is unavailable');
    }
    if (response.status >= 400) throw await safeBridgeError(response);
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new SandboxBridgeError('Sandbox returned an invalid response');
    }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new SandboxBridgeError('Sandbox returned an invalid response');
    }
    return data as Record<string, unknown>;
  }

  /** 产物字节流。调用方负责消费或取消 body。 */
  async artifactStream(artifactId: string): Promise<Response> {
    if (!this.#started) throw new SandboxBridgeError('Sandbox bridge is unavailable');
    let response: Response;
    try {
      response = await this.#fetch(
        this.#url(`/internal/mcp/v1/artifacts/${encodeURIComponent(artifactId)}/content`),
        { method: 'GET', headers: this.#headers, signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS) },
      );
    } catch {
      throw new SandboxBridgeError('Artifact is unavailable');
    }
    if (response.status >= 400) {
      // 不读 body，直接丢弃，避免连接悬着。
      await response.body?.cancel();
      throw new SandboxBridgeError('Artifact is unavailable');
    }
    return response;
  }
}
