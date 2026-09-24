/**
 * 会话释放前给在途的模型标题一个有界的收尾窗口。
 *
 * dsh-base 的 `session-title-first-prompt-llm` 在首条提问后**异步**请求模型生成标题；
 * 会话一旦 dispose，在途的标题工作被中止（dsh-session-title：「会话 dispose … 中止旧工作」）。
 * 我们每个 Run 结束就 dispose 会话，于是回答越短，标题越容易丢——2026-09-25 dev 真实链路：
 * 3 秒的回答只留下了确定性回退，`session/title-llm-request` 之后没有结果。
 *
 * 规则：只在「本会话最后一次标题请求之后还没有模型来源的标题」时等，最多 `graceMs`，
 * 其余情况立即返回。等不到（模型失败、超时）就放弃——标题是锦上添花，不能拖住 Run。
 */

export const DEFAULT_TITLE_GRACE_MS = 5_000;
const POLL_MS = 100;

interface EventLike {
  readonly type?: unknown;
  readonly data?: unknown;
}

/** 最后一次标题请求之后还没有模型来源的标题 = 在途。 */
export function titleRequestPending(events: readonly EventLike[]): boolean {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type === 'session/title') {
      const kind = (event.data as { source?: { kind?: unknown } } | undefined)?.source?.kind;
      if (kind === 'provider') return false;
    }
    if (event?.type === 'session/title-llm-request') return true;
  }
  return false;
}

export async function waitForPendingTitle(
  readEvents: () => readonly EventLike[] | undefined,
  opts: { graceMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<'none' | 'landed' | 'gave-up'> {
  const graceMs = opts.graceMs ?? DEFAULT_TITLE_GRACE_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = opts.now ?? Date.now;
  if (!titleRequestPending(readEvents() ?? [])) return 'none';
  const deadline = now() + graceMs;
  while (now() < deadline) {
    await sleep(POLL_MS);
    if (!titleRequestPending(readEvents() ?? [])) return 'landed';
  }
  return 'gave-up';
}
