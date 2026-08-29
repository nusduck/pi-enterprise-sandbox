/**
 * 单实例锁抽象（ADR 0008 D5 的预留扩展点）。
 *
 * 背景：`dsh-fs-local` 按目标的互斥锁只在**进程内**有效（上游文档原话）。
 * ADR 0008 D5 的决策是"前期单实例部署，但把多实例扩展点预留出来"——
 * exec 服务今天单进程 + `worker_threads`，进程内加锁因此完整有效；
 * 将来要横向扩到多实例时，只需要把 `WorkspaceLock` 的实现换成 MySQL
 * 咨询锁（`GET_LOCK`/`RELEASE_LOCK`）或者 Redis 锁，**调用方一行不改**。
 *
 * 这不是给文件系统层用的（`dsh-fs-local` 自己的按目标锁已经够用，见
 * `exec/src/fs/workspace-fs.ts` 的说明）。这是给本模块（`quota-ledger.ts`）
 * 的"读用量 → 判定 → 写预留"临界区用的——对应 Python 版
 * `workspace_quota_ledger.py` 里 `threading.RLock` + 按 workspace 的
 * `fcntl.flock`（`_exclusive_quota_lock`）那一段。Python 的 fcntl 锁是
 * "同机多 worker 安全"的原始实现；我们直接换成这个接口，默认实现在单进程
 * 场景下等价，多实例场景下把默认实现换掉即可，不用像 Python 那样跨语言
 * 移植 `fcntl`。
 */

/** 按 key 互斥执行异步临界区。key 通常是 `workspaceId`。 */
export interface WorkspaceLock {
  /**
   * 独占持有 `key` 期间执行 `fn`，返回其结果。同一个 `key` 的并发调用严格
   * 排队执行；不同 `key` 之间互不阻塞。`fn` 抛出的错误会原样向外传播，
   * 且锁一定会被释放（`finally` 语义），不会因为一次失败的临界区把 `key`
   * 永久锁死。
   */
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

/**
 * 默认（进程内）实现：每个 `key` 维护一条 Promise 链，新的 `withLock()`
 * 调用排在链尾之后执行，前一个临界区（无论成功还是失败）结束后才轮到下一个。
 *
 * 这就是"进程内按 key 互斥"的最小实现——单个 Node 事件循环本来就是单线程，
 * 不需要真正的操作系统锁，只需要保证"同一个 key 的异步临界区不交叉执行"。
 * 用完的 key 从 `chains` 里删除，避免长期运行的服务里这张表无限增长。
 */
export class InProcessWorkspaceLock implements WorkspaceLock {
  /** 每个 key 存的是"排在它前面的最后一个任务，settle 之后"的 Promise——
   * 不区分成功/失败，因为下一个排队者不该因为前一个任务失败就永远卡住。 */
  private readonly tails = new Map<string, Promise<void>>();

  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const priorSettled = this.tails.get(key) ?? Promise.resolve();
    const result = priorSettled.then(fn);
    const nextTail = result.then(
      () => undefined,
      () => undefined,
    );
    // 下面这一整段到 `set()` 为止全是同步代码——没有 `await`——所以两次
    // "背靠背"调用（比如 `Promise.all([lock.withLock(k, a), lock.withLock(k, b)])`）
    // 里，第二次调用读到的一定是第一次调用刚写入的 `nextTail`，排队顺序
    // 由调用顺序决定，不受微任务调度影响。
    this.tails.set(key, nextTail);
    try {
      return await result;
    } finally {
      // 只有当我还是这个 key 最新的一环时才清理，避免把后来排队者的占位删掉。
      if (this.tails.get(key) === nextTail) {
        this.tails.delete(key);
      }
    }
  }
}
