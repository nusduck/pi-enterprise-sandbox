/**
 * facade 业务逻辑：上下文路由、桥调用、产物 URL 签名。
 * 移植自 `sandbox/mcp/service.py`。
 *
 * ## Model Experience
 * 每个工具结果都以 `context_id` 开头回显，模型据此把后续调用绑到同一个工作区
 * ——这是它唯一能表达"接着刚才那个工作区做"的手段。上限（代码长度、命令长度、
 * 文件大小、超时）在**发桥之前**就判定，所以超限的失败不消耗执行面时间，
 * 拒绝文案是固定短句，对 KV cache 友好。
 *
 * ## Known Limitations and Deferred Work
 * - 下载 URL 的签名只绑 `artifact_id` 与过期时间，不绑调用者：拿到 URL 的人在
 *   TTL 内都能下载。与 Python 版一致；要绑调用者需要 facade 侧有身份概念。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { SandboxBridgeClient, SandboxBridgeError } from './bridge-client.js';
import { ContextStore, ContextStoreError, type ContextRecord } from './context-store.js';
import type { McpSettings } from './settings.js';
import { newUlid } from './ulid.js';
import { validateRuntime } from './settings.js';

/** 经 MCP 协议返回给调用方的安全消息。 */
export class McpFacadeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpFacadeError';
  }
}

type Json = Record<string, unknown>;

function b64(data: Buffer): string {
  return data.toString('base64url');
}

function unb64(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.js': 'text/javascript',
  '.xml': 'application/xml',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function guessMimeType(name: string): string | null {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return null;
  return MIME_BY_EXT[name.slice(dot).toLowerCase()] ?? null;
}

export class McpFacadeService {
  readonly #settings: McpSettings;
  readonly #contextStore: ContextStore;
  readonly #bridge: SandboxBridgeClient;

  constructor(settings: McpSettings, contextStore: ContextStore, bridge: SandboxBridgeClient) {
    this.#settings = settings;
    this.#contextStore = contextStore;
    this.#bridge = bridge;
  }

  async start(): Promise<void> {
    validateRuntime(this.#settings);
    await this.#contextStore.start();
    this.#bridge.start();
  }

  async close(): Promise<void> {
    this.#bridge.close();
    await this.#contextStore.close();
  }

  static #contextPayload(record: ContextRecord): Json {
    return {
      sandbox_session_id: record.sandboxSessionId,
      workspace_id: record.workspaceId,
    };
  }

  async #resolve(contextId: string | null | undefined): Promise<ContextRecord> {
    try {
      return await this.#contextStore.resolve(contextId, (record) =>
        this.#bridge.post('/internal/mcp/v1/context/ensure', McpFacadeService.#contextPayload(record)),
      );
    } catch (error) {
      if (error instanceof ContextStoreError || error instanceof SandboxBridgeError) {
        throw new McpFacadeError(error.message);
      }
      throw error;
    }
  }

  async #call(
    path: string,
    contextId: string | null | undefined,
    payload: Json,
  ): Promise<[ContextRecord, Json]> {
    const record = await this.#resolve(contextId);
    try {
      const data = await this.#bridge.post(path, {
        ...McpFacadeService.#contextPayload(record),
        ...payload,
      });
      await this.#contextStore.touch(record);
      return [record, data];
    } catch (error) {
      if (error instanceof ContextStoreError || error instanceof SandboxBridgeError) {
        throw new McpFacadeError(error.message);
      }
      throw error;
    }
  }

  #checkTimeout(timeoutSeconds: number): void {
    if (!(timeoutSeconds >= 1 && timeoutSeconds <= this.#settings.maxTimeoutSeconds)) {
      throw new McpFacadeError('timeout_seconds exceeds MCP limit');
    }
  }

  async executePython(input: {
    contextId?: string | null;
    code: string;
    timeoutSeconds?: number;
  }): Promise<Json> {
    const timeoutSeconds = input.timeoutSeconds ?? 120;
    if (input.code.length > this.#settings.maxCodeLength) {
      throw new McpFacadeError('code exceeds MCP size limit');
    }
    this.#checkTimeout(timeoutSeconds);
    const [record, data] = await this.#call('/internal/mcp/v1/python/execute', input.contextId, {
      code: input.code,
      timeout_seconds: timeoutSeconds,
    });
    return { context_id: record.contextId, ...data };
  }

  async executeShell(input: {
    contextId?: string | null;
    command: string;
    timeoutSeconds?: number;
  }): Promise<Json> {
    const timeoutSeconds = input.timeoutSeconds ?? 120;
    if (input.command.length > this.#settings.maxCommandLength) {
      throw new McpFacadeError('command exceeds MCP size limit');
    }
    this.#checkTimeout(timeoutSeconds);
    const [record, data] = await this.#call('/internal/mcp/v1/shell/execute', input.contextId, {
      command: input.command,
      timeout_seconds: timeoutSeconds,
    });
    return { context_id: record.contextId, ...data };
  }

  async fileWrite(input: {
    contextId?: string | null;
    path: string;
    content: string;
    mode?: string;
  }): Promise<Json> {
    const mode = input.mode ?? 'overwrite';
    if (mode !== 'overwrite' && mode !== 'append') {
      throw new McpFacadeError('mode must be overwrite or append');
    }
    if (Buffer.byteLength(input.content, 'utf8') > this.#settings.maxFileSizeBytes) {
      throw new McpFacadeError('content exceeds MCP file size limit');
    }
    const [record, data] = await this.#call('/internal/mcp/v1/files/write', input.contextId, {
      path: input.path,
      content: input.content,
      mode,
    });
    return { context_id: record.contextId, ...data };
  }

  async fileRead(input: {
    contextId?: string | null;
    path: string;
    offset?: number | null;
    limit?: number | null;
  }): Promise<Json> {
    const [record, data] = await this.#call('/internal/mcp/v1/files/read', input.contextId, {
      path: input.path,
      offset: input.offset ?? null,
      limit: input.limit ?? null,
    });
    return { context_id: record.contextId, ...data };
  }

  async fileList(input: {
    contextId?: string | null;
    path?: string;
    depth?: number;
  }): Promise<Json> {
    const depth = input.depth ?? 1;
    if (!(depth >= 0 && depth <= 5)) throw new McpFacadeError('depth must be in 0..5');
    const [record, data] = await this.#call('/internal/mcp/v1/files/list', input.contextId, {
      path: input.path ?? '.',
      depth,
    });
    return { context_id: record.contextId, ...data };
  }

  #signArtifact(artifactId: string, expiresAt: number): string {
    const body = b64(Buffer.from(JSON.stringify({ artifact_id: artifactId, exp: expiresAt })));
    const signature = createHmac('sha256', this.#settings.downloadSecret).update(body).digest();
    return `${body}.${b64(signature)}`;
  }

  verifyArtifactToken(artifactId: string, token: string): boolean {
    try {
      const dot = token.indexOf('.');
      if (dot < 0) return false;
      const body = token.slice(0, dot);
      const signature = token.slice(dot + 1);
      const expected = createHmac('sha256', this.#settings.downloadSecret).update(body).digest();
      const provided = unb64(signature);
      if (provided.length !== expected.length) return false;
      if (!timingSafeEqual(provided, expected)) return false;
      const payload: unknown = JSON.parse(unb64(body).toString('utf8'));
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false;
      const record = payload as Record<string, unknown>;
      return (
        record['artifact_id'] === artifactId && Number(record['exp'] ?? 0) >= Math.floor(Date.now() / 1000)
      );
    } catch {
      return false;
    }
  }

  async artifactSubmit(input: {
    contextId?: string | null;
    sourcePath: string;
    name?: string | null;
    mimeType?: string | null;
  }): Promise<Json> {
    const artifactId = newUlid();
    const fallbackName = input.sourcePath.split('/').pop() ?? '';
    const artifactName = (input.name ?? fallbackName).trim();
    if (
      artifactName === '' ||
      artifactName === '.' ||
      artifactName === '..' ||
      artifactName.includes('/') ||
      artifactName.includes('\\')
    ) {
      throw new McpFacadeError('name must be a filename');
    }
    const artifactMime =
      input.mimeType ?? guessMimeType(artifactName) ?? 'application/octet-stream';
    const [record, data] = await this.#call('/internal/mcp/v1/artifacts/submit', input.contextId, {
      artifact_id: artifactId,
      source_path: input.sourcePath,
    });
    const expiresAt = Math.floor(Date.now() / 1000) + this.#settings.artifactTtlSeconds;
    await this.#contextStore.putArtifact(artifactId, {
      name: artifactName,
      mime_type: artifactMime,
      size: Number(data['size']),
      sha256: String(data['sha256']),
      context_id: record.contextId,
      // 存下路径，下载时才能从它借扩展名（displayName 常是没有后缀的标题）。
      path: input.sourcePath,
      // 下载时要拿它做归属维度，见 bridge-client.artifactStream()。
      sandbox_session_id: record.sandboxSessionId,
    });
    const token = this.#signArtifact(artifactId, expiresAt);
    const query = new URLSearchParams({ token }).toString();
    const root = this.#settings.publicBaseUrl.replace(/\/+$/, '');
    const url = `${root}/artifacts/${artifactId}?${query}`;
    return {
      context_id: record.contextId,
      artifact_id: artifactId,
      name: artifactName,
      mime_type: artifactMime,
      size: Number(data['size']),
      sha256: String(data['sha256']),
      download_url: url,
      expires_at: expiresAt,
    };
  }

  async getArtifact(artifactId: string, token: string): Promise<Record<string, unknown> | null> {
    if (!this.verifyArtifactToken(artifactId, token)) return null;
    try {
      return await this.#contextStore.getArtifact(artifactId);
    } catch (error) {
      if (error instanceof ContextStoreError) throw new McpFacadeError(error.message);
      throw error;
    }
  }

  async artifactStream(artifactId: string, sandboxSessionId: string): Promise<Response> {
    try {
      return await this.#bridge.artifactStream(artifactId, sandboxSessionId);
    } catch (error) {
      if (error instanceof SandboxBridgeError) throw new McpFacadeError(error.message);
      throw error;
    }
  }
}
