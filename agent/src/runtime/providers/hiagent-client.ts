/**
 * 出站 HiAgent 客户端（docs/design/hiagent-remote-delegation.md §1/H6/H7）。
 *
 * 火山引擎 HiAgent 没有 A2A 面，只有应用对话 API；本仓库直接用 `fetch` 实现，
 * 不引入 Python SDK。字段大小写以官方 SDK 源码为准核对过：
 * - 请求体 PascalCase：`POST {baseUrl}/create_conversation` 带 `{ AppKey, Inputs, UserID }`，
 *   `POST {baseUrl}/chat_query_v2` 带 `{ AppKey, AppConversationID, Query, ResponseMode: "blocking", UserID }`；
 * - 阻塞响应小写 snake_case：`event, task_id, id, conversation_id, answer, created_at`
 *  （`think_messages?` / `tool_messages?` 按 H7 不回给模型）；
 * - 鉴权头 `Apikey: <AppKey>`（注意大小写：A-p-i-k-e-y）；
 * - 错误体含 `ResponseMetadata.Error.{Code, Message}`。
 *
 * 未知响应形状按错误处理，不猜测。凭据只在调用时从 `authTokenRef` 指向的环境变量读，
 * 不写日志、不进错误信息、不进数据库。
 */
import type { HiAgentRemoteAgentEntry } from './a2a-remote-registry.js';
import { RESULT_TEXT_MAX_CHARS } from './a2a-remote-client.js';

export const HIAGENT_CREATE_ACTION = 'create_conversation';
export const HIAGENT_CHAT_ACTION = 'chat_query_v2';
export const DEFAULT_HIAGENT_MAX_RESPONSE_BYTES = 1024 * 1024;

export class HiAgentError extends Error {
  readonly code: string;
  /** HiAgent 错误体里的 `ResponseMetadata.Error.Code`（诊断用，不含凭据）。 */
  readonly serverCode: string | null;
  constructor(code: string, message: string, serverCode: string | null = null) {
    super(`${code}: ${message}`);
    this.name = 'HiAgentError';
    this.code = code;
    this.serverCode = serverCode;
  }
}

export interface HiAgentChatResult {
  readonly taskId: string | null;
  readonly text: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 读响应体，超过上限即中止（与 A2A 客户端同一规则）。 */
async function readBounded(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new HiAgentError('HIAGENT_UNAVAILABLE', `response exceeds ${maxBytes} bytes`);
  }
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new HiAgentError('HIAGENT_UNAVAILABLE', `response exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  return buf;
}

export class HiAgentClient {
  readonly #env: Record<string, string | undefined>;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #maxResponseBytes: number;

  constructor(opts: {
    env?: Record<string, string | undefined>;
    fetchImpl?: typeof fetch;
    now?: () => number;
    maxResponseBytes?: number;
  } = {}) {
    this.#env = opts.env ?? process.env;
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#now = opts.now ?? Date.now;
    this.#maxResponseBytes = opts.maxResponseBytes ?? DEFAULT_HIAGENT_MAX_RESPONSE_BYTES;
  }

  /** 建远端会话，返回 `Conversation.AppConversationID`。 */
  async createConversation(input: {
    entry: HiAgentRemoteAgentEntry;
    userId: string;
    signal?: AbortSignal;
  }): Promise<string> {
    const started = this.#now();
    const body = await this.#post(input.entry, HIAGENT_CREATE_ACTION, {
      AppKey: this.#appKey(input.entry),
      Inputs: {},
      UserID: input.userId,
    }, input.signal);
    const conversation = isPlainObject(body.Conversation) ? body.Conversation : null;
    const id = conversation && typeof conversation.AppConversationID === 'string'
      ? conversation.AppConversationID.trim()
      : '';
    if (!id) {
      throw new HiAgentError('HIAGENT_UNAVAILABLE', `remote ${input.entry.id} returned no AppConversationID`);
    }
    // 不记 prompt、不记凭据（与 a2a-client 的 D7 同一纪律）。
    console.info(`[hiagent-client] remote=${input.entry.id} action=create_conversation ms=${this.#now() - started}`);
    return id;
  }

  /** 一轮阻塞对话。`think_messages` / `tool_messages` 按 H7 丢弃，不回给模型。 */
  async chat(input: {
    entry: HiAgentRemoteAgentEntry;
    userId: string;
    remoteConversationId: string;
    prompt: string;
    signal?: AbortSignal;
  }): Promise<HiAgentChatResult> {
    const started = this.#now();
    const body = await this.#post(input.entry, HIAGENT_CHAT_ACTION, {
      AppKey: this.#appKey(input.entry),
      AppConversationID: input.remoteConversationId,
      Query: input.prompt,
      ResponseMode: 'blocking',
      UserID: input.userId,
    }, input.signal);
    if (typeof body.answer !== 'string' || !body.answer) {
      throw new HiAgentError('HIAGENT_UNAVAILABLE', `remote ${input.entry.id} returned no text answer`);
    }
    const taskId = typeof body.task_id === 'string' && body.task_id ? body.task_id : null;
    console.info(
      `[hiagent-client] remote=${input.entry.id} task=${taskId ?? '-'} state=completed ms=${this.#now() - started}`,
    );
    return { taskId, text: body.answer.slice(0, RESULT_TEXT_MAX_CHARS) };
  }

  #appKey(entry: HiAgentRemoteAgentEntry): string {
    const key = String(this.#env[entry.authTokenRef] ?? '').trim();
    if (!key) {
      throw new HiAgentError('HIAGENT_UNAVAILABLE', `credential ${entry.authTokenRef} is not set`);
    }
    return key;
  }

  /** 发一个应用 API 请求：超时、中断、大小上限、错误体识别。返回解析后的 JSON 对象。 */
  async #post(
    entry: HiAgentRemoteAgentEntry,
    action: string,
    params: Record<string, unknown>,
    callerSignal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const url = `${entry.baseUrl}/${action}`;
    const timeout = AbortSignal.timeout(entry.timeoutMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
    let res: Response;
    try {
      // AppKey 只进请求头与请求体，不进 URL、不进日志、不进错误。
      const headers = new Headers();
      headers.set('Apikey', this.#appKey(entry));
      headers.set('Content-Type', 'application/json');
      res = await this.#fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...params, AppKey: this.#appKey(entry) }),
        signal,
        redirect: 'error',
      });
    } catch (err) {
      if (err instanceof HiAgentError) throw err;
      const reason = timeout.aborted
        ? `request timed out after ${entry.timeoutMs} ms`
        : (err as Error)?.message ?? String(err);
      throw new HiAgentError('HIAGENT_UNAVAILABLE', `remote ${entry.id}: ${reason}`);
    }
    const raw = new TextDecoder().decode(await readBounded(res, this.#maxResponseBytes));
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new HiAgentError('HIAGENT_UNAVAILABLE', `remote ${entry.id} returned non-JSON response (http ${res.status})`);
    }
    if (!isPlainObject(parsed)) {
      throw new HiAgentError('HIAGENT_UNAVAILABLE', `remote ${entry.id} returned an unexpected response shape`);
    }
    // 错误判定与 SDK 的 `IsErrorResult` 同义：体里带 ResponseMetadata + Code + Error。
    const metadata = isPlainObject(parsed.ResponseMetadata) ? parsed.ResponseMetadata : null;
    const serverError = metadata && isPlainObject(metadata.Error) ? metadata.Error : null;
    if (serverError) {
      const code = typeof serverError.Code === 'string' && serverError.Code ? serverError.Code : 'unknown';
      const message = typeof serverError.Message === 'string' && serverError.Message
        ? serverError.Message.slice(0, 500)
        : '';
      throw new HiAgentError(
        'HIAGENT_FAILED',
        `remote ${entry.id} ${code}${message ? `: ${message}` : ''}`,
        code,
      );
    }
    if (!res.ok) {
      throw new HiAgentError('HIAGENT_UNAVAILABLE', `remote ${entry.id} http ${res.status}`);
    }
    return parsed;
  }
}

/**
 * 远端会话是否已失效（H5：删绑定、新建会话、只重试一次）。
 * 只认「提到 conversation 且说不存在/非法/过期」：`Query invalid` 这类与会话无关的
 * 错误不能触发重建，否则每次普通失败都会悄悄换会话。
 */
export function isHiAgentSessionInvalid(err: unknown): boolean {
  if (!(err instanceof HiAgentError) || err.code !== 'HIAGENT_FAILED') return false;
  const detail = `${err.serverCode ?? ''} ${err.message}`;
  return /conversation/i.test(detail) &&
    /not[ _-]?found|not[ _-]?exist|does not exist|unknown|invalid|expired|deleted|missing|not_found/i.test(detail);
}
