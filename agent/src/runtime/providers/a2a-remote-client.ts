/**
 * 出站 A2A 客户端（docs/design/a2a-remote-delegation.md D1/D5/D6）。
 *
 * 用官方 `@a2a-js/sdk/client`：ADR 0010 否决的只是 SDK 的**服务端**（跨进程续传、
 * 多租户审计、方法名双轨），客户端侧「取卡片 → 发消息 → 查任务 → 取消」SDK 正好覆盖。
 * `legacyCompat` 打开，v1.0 与 v0.3 的远端（包括本仓库自己的 A2A 面）都能调。
 *
 * 所有 HTTP 都经 `boundedFetch`：
 * - 只发往 `cardUrl` 同源——卡片里写的端点若指向别处，Bearer 凭据不跟过去；
 * - 不跟随重定向（重定向同样可能把凭据带走）；
 * - 单请求超时、响应体上限。
 */
import { createHash } from 'node:crypto';
import {
  GetTaskRequest,
  Role,
  SendMessageRequest,
  TaskState,
  type AgentCard,
  type Message,
  type Part,
  type Task,
} from '@a2a-js/sdk';
import {
  ClientFactory,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  type Client,
} from '@a2a-js/sdk/client';
import type { RemoteAgentEntry } from './a2a-remote-registry.js';

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const CARD_REQUEST_TIMEOUT_MS = 10_000;
export const CANCEL_REQUEST_TIMEOUT_MS = 5_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
export const CARD_CACHE_TTL_MS = 5 * 60 * 1000;
export const RESULT_TEXT_MAX_CHARS = 16_000;
/** 终态没有 status/artifact 文本时，回读多少条 history 找答案。 */
const ANSWER_HISTORY_LENGTH = 20;
const POLL_MIN_DELAY_MS = 2_000;
const POLL_MAX_DELAY_MS = 15_000;

export class RemoteA2aError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'RemoteA2aError';
    this.code = code;
  }
}

export interface RemoteArtifactRef {
  readonly name: string;
  readonly mimeType: string | null;
  readonly url: string | null;
}

export interface RemoteDelegationResult {
  readonly remoteAgent: string;
  readonly taskId: string | null;
  readonly state: string;
  readonly text: string;
  readonly artifacts: readonly RemoteArtifactRef[];
}

type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

/** 卡片缓存条目。具名而不内联：B3 瞬态 Map 棘轮的扫描正则认不出带 `{ ; }` 的内联泛型。 */
type CardCacheEntry = { card: AgentCard; expiresAt: number };

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish);
  });
}

/** 由 (runId, callId) 派生的稳定 UUID：同一次工具调用重试时远端可去重。 */
export function deriveMessageId(runId: string, callId: string): string {
  const h = createHash('sha256').update(`${runId}:${callId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function stateName(state: TaskState | undefined): string {
  switch (state) {
    case TaskState.TASK_STATE_SUBMITTED: return 'submitted';
    case TaskState.TASK_STATE_WORKING: return 'working';
    case TaskState.TASK_STATE_COMPLETED: return 'completed';
    case TaskState.TASK_STATE_FAILED: return 'failed';
    case TaskState.TASK_STATE_CANCELED: return 'canceled';
    case TaskState.TASK_STATE_INPUT_REQUIRED: return 'input-required';
    case TaskState.TASK_STATE_REJECTED: return 'rejected';
    case TaskState.TASK_STATE_AUTH_REQUIRED: return 'auth-required';
    default: return 'unknown';
  }
}

const TERMINAL_OR_INTERRUPTED = new Set([
  'completed', 'failed', 'canceled', 'rejected', 'input-required', 'auth-required',
]);

function partsText(parts: readonly Part[] | undefined): string[] {
  const out: string[] = [];
  for (const part of parts ?? []) {
    if (part?.content?.$case === 'text' && part.content.value.trim()) out.push(part.content.value.trim());
  }
  return out;
}

function isTask(value: Message | Task): value is Task {
  return typeof (value as Task).status === 'object' || Array.isArray((value as Task).artifacts);
}

/** 读响应体，超过上限即中止。 */
async function readBounded(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new RemoteA2aError('A2A_REMOTE_UNAVAILABLE', `response exceeds ${maxBytes} bytes`);
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
      throw new RemoteA2aError('A2A_REMOTE_UNAVAILABLE', `response exceeds ${maxBytes} bytes`);
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

export class RemoteA2aClient {
  readonly #env: Record<string, string | undefined>;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #sleep: Sleep;
  readonly #requestTimeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #cards = new Map<string, CardCacheEntry>();

  constructor(opts: {
    env?: Record<string, string | undefined>;
    fetchImpl?: typeof fetch;
    now?: () => number;
    sleep?: Sleep;
    requestTimeoutMs?: number;
    maxResponseBytes?: number;
  } = {}) {
    this.#env = opts.env ?? process.env;
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#now = opts.now ?? Date.now;
    this.#sleep = opts.sleep ?? defaultSleep;
    this.#requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#maxResponseBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  }

  /** 该远端专用的 fetch：同源、带凭据、不跟重定向、有超时、有大小上限。 */
  #boundedFetch(entry: RemoteAgentEntry, timeoutMs = this.#requestTimeoutMs): typeof fetch {
    const origin = new URL(entry.cardUrl).origin;
    return async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== origin) {
        throw new RemoteA2aError(
          'A2A_REMOTE_UNAVAILABLE',
          `remote ${entry.id} advertised an endpoint outside ${origin}; refusing to send credentials`,
        );
      }
      const token = String(this.#env[entry.authTokenRef] ?? '').trim();
      if (!token) {
        throw new RemoteA2aError('A2A_REMOTE_UNAVAILABLE', `credential ${entry.authTokenRef} is not set`);
      }
      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
      headers.set('authorization', `Bearer ${token}`);
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
      let res: Response;
      try {
        res = await this.#fetch(url, {
          ...init,
          method: init?.method ?? (input instanceof Request ? input.method : undefined),
          body: init?.body ?? (input instanceof Request ? input.body : undefined),
          headers,
          signal,
          redirect: 'error',
        } as RequestInit);
      } catch (err) {
        if (err instanceof RemoteA2aError) throw err;
        const reason = timeout.aborted ? `request timed out after ${timeoutMs} ms` : (err as Error).message;
        throw new RemoteA2aError('A2A_REMOTE_UNAVAILABLE', `remote ${entry.id}: ${reason}`);
      }
      const body = await readBounded(res, this.#maxResponseBytes);
      return new Response(body.byteLength ? body : null, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
    };
  }

  async #card(entry: RemoteAgentEntry): Promise<AgentCard> {
    const cached = this.#cards.get(entry.id);
    if (cached && cached.expiresAt > this.#now()) return cached.card;
    const resolver = new DefaultAgentCardResolver({
      fetchImpl: this.#boundedFetch(entry, CARD_REQUEST_TIMEOUT_MS),
      legacyCompat: { enabled: true },
    });
    let card: AgentCard;
    try {
      card = await resolver.resolve(entry.cardUrl, '');
    } catch (err) {
      if (err instanceof RemoteA2aError) throw err;
      throw new RemoteA2aError('A2A_REMOTE_UNAVAILABLE', `remote ${entry.id} agent card: ${(err as Error).message}`);
    }
    const origin = new URL(entry.cardUrl).origin;
    const interfaces = card.supportedInterfaces ?? [];
    if (interfaces.length === 0 || interfaces.some((i) => new URL(i.url, entry.cardUrl).origin !== origin)) {
      throw new RemoteA2aError(
        'A2A_REMOTE_UNAVAILABLE',
        `remote ${entry.id} agent card must only advertise endpoints on ${origin}`,
      );
    }
    this.#cards.set(entry.id, { card, expiresAt: this.#now() + CARD_CACHE_TTL_MS });
    return card;
  }

  async #client(entry: RemoteAgentEntry): Promise<Client> {
    const card = await this.#card(entry);
    const factory = new ClientFactory({
      transports: [
        new JsonRpcTransportFactory({
          fetchImpl: this.#boundedFetch(entry),
          legacyCompat: { enabled: true },
        }),
      ],
    });
    try {
      return await factory.createFromAgentCard(card);
    } catch (err) {
      throw new RemoteA2aError('A2A_REMOTE_UNAVAILABLE', `remote ${entry.id}: ${(err as Error).message}`);
    }
  }

  /**
   * 发一个任务并等到终态（或被打断）。超时与取消都会尽力给远端发一次 cancel。
   */
  async delegate(input: {
    entry: RemoteAgentEntry;
    prompt: string;
    messageId: string;
    signal?: AbortSignal;
  }): Promise<RemoteDelegationResult> {
    const { entry } = input;
    const started = this.#now();
    const deadline = AbortSignal.timeout(entry.timeoutMs);
    const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
    const client = await this.#client(entry);

    const wrap = (err: unknown): RemoteA2aError => {
      if (err instanceof RemoteA2aError) return err;
      if (deadline.aborted) {
        return new RemoteA2aError('A2A_REMOTE_TIMEOUT', `remote ${entry.id} did not finish within ${entry.timeoutMs} ms`);
      }
      return new RemoteA2aError('A2A_REMOTE_UNAVAILABLE', `remote ${entry.id}: ${(err as Error)?.message ?? String(err)}`);
    };

    let result: Message | Task;
    try {
      result = await client.sendMessage(
        SendMessageRequest.fromJSON({
          message: {
            messageId: input.messageId,
            role: 'ROLE_USER',
            parts: [{ text: input.prompt, mediaType: 'text/plain' }],
          },
          configuration: { acceptedOutputModes: ['text/plain'], returnImmediately: true },
        }),
        { signal },
      );
    } catch (err) {
      throw wrap(err);
    }

    if (!isTask(result)) {
      // 远端直接回了一条消息，没有建任务：那就是答案。
      return this.#finish(entry, started, {
        taskId: null,
        state: 'completed',
        texts: partsText(result.parts),
        artifacts: [],
      });
    }

    let task = result;
    let delay = POLL_MIN_DELAY_MS;
    while (!TERMINAL_OR_INTERRUPTED.has(stateName(task.status?.state))) {
      if (signal.aborted) {
        await this.#cancel(client, task.id);
        throw wrap(new Error('delegation cancelled'));
      }
      await this.#sleep(delay, signal);
      delay = Math.min(delay * 2, POLL_MAX_DELAY_MS);
      if (signal.aborted) continue;
      try {
        task = await client.getTask(GetTaskRequest.fromJSON({ id: task.id, historyLength: 0 }), { signal });
      } catch (err) {
        if (signal.aborted) continue;
        throw wrap(err);
      }
    }

    const state = stateName(task.status?.state);
    let texts = [
      ...partsText(task.status?.message?.parts),
      ...(task.artifacts ?? []).flatMap((a) => partsText(a.parts)),
    ];
    if (texts.length === 0 && state === 'completed') {
      // A2A 允许把回答只放在 history 里——本仓库自己的 A2A 面就是这样
      // （task-service.ts：status 不带 message、纯文本回答不产 artifact）。
      // 轮询时不带 history 省带宽，这里补读一次，取最后一条 agent 消息。
      try {
        const withHistory = await client.getTask(
          GetTaskRequest.fromJSON({ id: task.id, historyLength: ANSWER_HISTORY_LENGTH }),
          { signal },
        );
        const lastAgent = [...(withHistory.history ?? [])].reverse().find((m) => m.role === Role.ROLE_AGENT);
        texts = partsText(lastAgent?.parts);
      } catch (err) {
        throw wrap(err);
      }
    }
    const artifacts = (task.artifacts ?? []).map((a) => {
      const urlPart = (a.parts ?? []).find((p) => p?.content?.$case === 'url');
      return {
        name: a.name || a.artifactId,
        mimeType: (a.parts ?? []).find((p) => p?.mediaType)?.mediaType || null,
        url: urlPart?.content?.$case === 'url' ? urlPart.content.value : null,
      };
    });
    if (state === 'input-required' || state === 'auth-required') {
      throw new RemoteA2aError('A2A_REMOTE_NEEDS_INPUT', `remote ${entry.id} task ${task.id} is ${state}`);
    }
    if (state !== 'completed') {
      const detail = texts.join('\n').slice(0, 500);
      throw new RemoteA2aError('A2A_REMOTE_FAILED', `remote ${entry.id} task ${task.id} ended ${state}${detail ? `: ${detail}` : ''}`);
    }
    return this.#finish(entry, started, { taskId: task.id, state, texts, artifacts });
  }

  async #cancel(client: Client, taskId: string): Promise<void> {
    try {
      await client.cancelTask({ tenant: '', id: taskId, metadata: undefined }, {
        signal: AbortSignal.timeout(CANCEL_REQUEST_TIMEOUT_MS),
      });
    } catch {
      // 尽力而为：远端不支持取消或已结束都不影响本地结论。
    }
  }

  #finish(
    entry: RemoteAgentEntry,
    started: number,
    r: { taskId: string | null; state: string; texts: string[]; artifacts: RemoteArtifactRef[] },
  ): RemoteDelegationResult {
    // 不记 prompt、不记凭据（设计 D7）。
    console.info(
      `[a2a-client] remote=${entry.id} task=${r.taskId ?? '-'} state=${r.state} ms=${this.#now() - started}`,
    );
    return {
      remoteAgent: entry.id,
      taskId: r.taskId,
      state: r.state,
      text: r.texts.join('\n\n').slice(0, RESULT_TEXT_MAX_CHARS),
      artifacts: r.artifacts,
    };
  }
}
