/**
 * 单调增量读游标——移植自 Python 版 `sandbox/services/process_cursor.py`。
 *
 * 这是什么：一个按 UTF-8 **字节**寻址的环形缓冲区，配一个
 * `{generation}-{offset}` 形式的游标。ADR 0008 §5.5 明确点名"这个模型和
 * 上游 `ShellProcess.readOutput()` 完全同形，是运气好的地方，别改坏"——
 * 上游的 `ShellProcessRead { delta, lossy, stdoutSpillPath?, stderrSpillPath? }`
 * 描述的正是"连续读不重复返回；丢数据时标记 lossy"这条语义，这个类就是
 * 实现它的最小、经过 Python 版长期验证的机制。
 *
 * 为什么不能用一个天真的"游标=已读字节数"："已读字节数"在缓冲区发生
 * 回收（超过内存上限、丢弃最老的一段）时会失真：客户端拿着一个指向已经
 * 被丢弃区间的偏移量再来读，naive 实现要么返回垃圾、要么静默返回空
 * （客户端分不清"暂时没有新输出"和"你请求的那段数据已经丢了"）。
 * `generation` 就是用来区分这两种情况的：每次发生丢弃，`generation` 自增，
 * 客户端游标的 generation 落后于当前值，就能确定地知道"你错过了一段，
 * 从当前保留窗口的起点重新开始"。
 *
 * 为什么要做 UTF-8 边界安全：`append`/`read` 都按字节操作（避免为每次
 * append 重新解码整个缓冲区的开销），但对外吐出的 `data` 必须是合法字符串
 * ——如果一次读取的边界恰好切在一个多字节字符中间，`Buffer.toString()`
 * 会产出替换字符（U+FFFD）损坏输出。所以每次读的起止都要向最近的字符边界
 * 挪动；`read()` 还保证"至少推进一个完整字符"（哪怕单个字符比 `limit`
 * 还大），否则一个 `limit` 小于下一个字符字节数的客户端会永远卡在同一个
 * 游标上拿不到任何进展。
 *
 * 与 Python 版的差异：原实现用 `threading.RLock` 保护 `append`/`read`
 * 免受多线程竞争。Node 是单线程事件循环，这个类的所有方法都是同步的
 * （不含 `await`），JS 运行时保证一次方法调用不会被同一进程内的另一次
 * 调用打断——不需要显式锁。
 */

const CURSOR_RE = /^(\d+)-(\d+)$/;

/** 空游标——从头开始读。 */
export const INITIAL_CURSOR = '0-0';

export interface StreamCursor {
  readonly generation: number;
  readonly offset: number;
}

export function encodeCursor(generation: number, offset: number): string {
  return `${generation}-${offset}`;
}

/**
 * 解析一个游标字符串。空/未提供 → generation 0、offset 0（从头开始）。
 * 格式不对、超长或出现负数一律抛 `Error`（HTTP 层映射成 400）。
 */
export function parseCursor(raw: string | null | undefined): StreamCursor {
  if (raw === null || raw === undefined || raw === '') {
    return { generation: 0, offset: 0 };
  }
  const text = raw.trim();
  if (text.length > 64) {
    throw new Error('cursor too long');
  }
  const match = CURSOR_RE.exec(text);
  if (!match) {
    throw new Error('cursor must be generation-offset (e.g. 0-0)');
  }
  const generation = Number(match[1]);
  const offset = Number(match[2]);
  if (!Number.isSafeInteger(generation) || !Number.isSafeInteger(offset)) {
    throw new Error('cursor values must be safe integers');
  }
  if (generation < 0 || offset < 0) {
    throw new Error('cursor values must be non-negative');
  }
  return { generation, offset };
}

// ── UTF-8 字节边界辅助函数 ────────────────────────────────────────────

/** UTF-8 延续字节的高两位是 `10`。 */
function isContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

/** 把 `index` 前移到最近的字符起点（或数组末尾）。 */
function utf8CharStart(data: Uint8Array, index: number): number {
  const n = data.length;
  if (index <= 0) return 0;
  if (index >= n) return n;
  let i = index;
  while (i < n && isContinuationByte(data[i] as number)) {
    i += 1;
  }
  return i;
}

/** 把 `end` 后退到最近的完整字符边界（不切断多字节字符）。 */
function utf8SafeEnd(data: Uint8Array, end: number): number {
  const n = data.length;
  if (end <= 0) return 0;
  if (end >= n) return n;
  let i = end;
  while (i > 0 && isContinuationByte(data[i] as number)) {
    i -= 1;
  }
  return i < end ? i : end;
}

/** `start` 处那个 UTF-8 码点的字节长度（1-4），数据不完整/无效时返回 0 或 1。 */
function utf8CodepointLen(data: Uint8Array, start: number): number {
  const n = data.length;
  if (start < 0 || start >= n) return 0;
  const b0 = data[start] as number;
  if (b0 < 0x80) return 1;
  let need: number;
  if ((b0 & 0xe0) === 0xc0) need = 2;
  else if ((b0 & 0xf0) === 0xe0) need = 3;
  else if ((b0 & 0xf8) === 0xf0) need = 4;
  else return 1; // 无效前导字节/意外的延续字节——跳过一个字节以保证前进
  if (start + need > n) return 0; // 缓冲区末尾数据不完整
  for (let j = 1; j < need; j += 1) {
    if (!isContinuationByte(data[start + j] as number)) return 1;
  }
  return need;
}

interface Chunk {
  readonly absStart: number;
  readonly data: Uint8Array;
}

export interface StreamReadResult {
  readonly data: string;
  readonly cursor: string;
  readonly nextCursor: string;
  readonly truncated: boolean;
  readonly generation: number;
  readonly logTotal: number;
  readonly dropped: boolean;
}

/**
 * 单个流（stdout+stderr 合并后的产物，或调用方选择的任意一路）的
 * 增量读缓冲区。生产者侧（`JobProcessHandle.readOutput()` 的实现）不断
 * `append()`；读者侧带着游标反复 `read()`，互不干扰。
 */
export class StreamCursorBuffer {
  private readonly maxBytes: number;
  private generation = 0;
  /** 有史以来 append 过的绝对字节总数（单调递增，从不因回收而回退）。 */
  private total = 0;
  /** 当前保留窗口第一个字节的绝对偏移量。 */
  private droppedThrough = 0;
  private chunks: Chunk[] = [];
  private truncated = false;

  constructor(maxBytes = 500_000) {
    this.maxBytes = Math.max(1, Math.trunc(maxBytes));
  }

  /** 追加文本；空字符串是无操作。 */
  append(text: string): void {
    if (!text) return;
    const raw = Buffer.from(text, 'utf8');
    if (raw.length === 0) return;

    const start = this.total;
    this.total += raw.length; // 完整原始长度总是先计入 total，即便整段都会被丢弃

    if (raw.length > this.maxBytes) {
      this.truncated = true;
      const [tail, dropInChunk] = utf8TailWithin(raw, this.maxBytes);
      const absTailStart = start + dropInChunk;
      this.chunks = tail.length > 0 ? [{ absStart: absTailStart, data: tail }] : [];
      if (absTailStart > this.droppedThrough) {
        this.droppedThrough = absTailStart;
        this.generation += 1;
      }
      this.trim();
      return;
    }

    this.chunks.push({ absStart: start, data: raw });
    this.trim();
  }

  private trim(): void {
    const retained = this.total - this.droppedThrough;
    if (retained <= this.maxBytes) return;
    this.truncated = true;
    let target = this.total - this.maxBytes;
    const newChunks: Chunk[] = [];
    let genBump = false;

    for (const { absStart, data } of this.chunks) {
      const end = absStart + data.length;
      if (end <= target) {
        genBump = true;
        continue;
      }
      if (absStart < target) {
        let local = target - absStart;
        local = utf8CharStart(data, local);
        if (local >= data.length) {
          genBump = true;
          continue;
        }
        const newStart = absStart + local;
        newChunks.push({ absStart: newStart, data: data.subarray(local) });
        target = newStart;
        genBump = true;
      } else {
        newChunks.push({ absStart, data });
      }
    }

    this.chunks = newChunks;
    if (newChunks.length > 0) {
      this.droppedThrough = Math.max(this.droppedThrough, newChunks[0]!.absStart);
    } else {
      this.droppedThrough = Math.max(this.droppedThrough, target);
    }

    // UTF-8 对齐之后仍然超预算，继续从左边丢。
    while (this.chunks.length > 0 && this.total - this.droppedThrough > this.maxBytes) {
      const first = this.chunks[0]!;
      const need = this.total - this.droppedThrough - this.maxBytes;
      if (need >= first.data.length) {
        this.chunks.shift();
        this.droppedThrough = first.absStart + first.data.length;
        genBump = true;
        continue;
      }
      const local = utf8CharStart(first.data, need);
      if (local >= first.data.length) {
        this.chunks.shift();
        this.droppedThrough = first.absStart + first.data.length;
        genBump = true;
        continue;
      }
      this.chunks[0] = { absStart: first.absStart + local, data: first.data.subarray(local) };
      this.droppedThrough = first.absStart + local;
      genBump = true;
      break;
    }

    if (genBump) this.generation += 1;
  }

  /** 保留窗口内的全部内容拼成一个字符串（用于快照/调试，不推进任何游标）。 */
  snapshotText(): string {
    return Buffer.concat(this.chunks.map((c) => c.data)).toString('utf8');
  }

  initialCursor(): string {
    return encodeCursor(this.generation, 0);
  }

  /**
   * 增量读取。语义详见文件头注释；下面只标出与 Python 版一致的关键点：
   * - offset 是 UTF-8 字节；`data` 永远是合法 Unicode。
   * - 游标落在字符中间时向前推进到下一个字符起点。
   * - "至少一个完整字符"：即使 `limit` 小于下一个字符的字节数，也把那个
   *   字符整个返回（最多超出 3 字节），保证游标必定前进。
   * - 相同游标 + limit 在 generation 不变、窗口未越过该 offset 的前提下幂等。
   */
  read(cursorInput: StreamCursor | string | null | undefined, limit: number): StreamReadResult {
    const cur =
      typeof cursorInput === 'object' && cursorInput !== null
        ? cursorInput
        : parseCursor(cursorInput ?? INITIAL_CURSOR);
    const lim = Math.max(1, Math.trunc(limit));

    const dropped = cur.offset < this.droppedThrough || cur.generation < this.generation;

    if (cur.generation > this.generation) {
      return this.emptyResult(cur, true, dropped);
    }

    let start: number;
    let truncatedFlag: boolean;
    if (cur.generation < this.generation || cur.offset < this.droppedThrough) {
      start = this.droppedThrough;
      truncatedFlag = true;
    } else {
      start = Math.max(cur.offset, this.droppedThrough);
      truncatedFlag = this.truncated && cur.offset < this.droppedThrough;
    }

    if (this.chunks.length === 0) {
      return this.emptyResult(cur, truncatedFlag || this.truncated, dropped);
    }

    const windowStart = this.chunks[0]!.absStart;
    const window = Buffer.concat(this.chunks.map((c) => c.data));
    let relStart = Math.max(0, start - windowStart);
    if (relStart >= window.length) {
      return this.emptyResult(cur, truncatedFlag || this.truncated, dropped);
    }
    relStart = utf8CharStart(window, relStart);
    if (relStart >= window.length) {
      return this.emptyResult(cur, truncatedFlag || this.truncated, dropped);
    }

    const relEndCap = Math.min(window.length, relStart + lim);
    let relEnd = utf8SafeEnd(window, relEndCap);
    if (relEnd < relStart) relEnd = relStart;

    if (relEnd === relStart) {
      const cpLen = utf8CodepointLen(window, relStart);
      if (cpLen > 0 && relStart + cpLen <= window.length) {
        relEnd = relStart + cpLen;
      }
      // 否则窗口里剩的是不完整的尾部片段：不编造数据，原地不动。
    }

    const chunk = window.subarray(relStart, relEnd);
    let absNext = windowStart + relEnd;
    if (absNext > this.total) absNext = this.total;
    const windowEndAbs = windowStart + window.length;
    if (absNext >= windowEndAbs && windowEndAbs >= this.total) {
      absNext = this.total;
    }

    return {
      data: chunk.toString('utf8'),
      cursor: encodeCursor(cur.generation, cur.offset),
      nextCursor: encodeCursor(this.generation, absNext),
      truncated: truncatedFlag || this.truncated,
      generation: this.generation,
      logTotal: this.total,
      dropped,
    };
  }

  private emptyResult(cur: StreamCursor, truncated: boolean, dropped: boolean): StreamReadResult {
    return {
      data: '',
      cursor: encodeCursor(cur.generation, cur.offset),
      nextCursor: encodeCursor(this.generation, this.total),
      truncated,
      generation: this.generation,
      logTotal: this.total,
      dropped,
    };
  }
}

/**
 * 保留 `raw` 中不超过 `maxBytes` 的合法 UTF-8 尾部。
 * 返回 `[tail, dropPrefixBytes]`；为避免切断码点，实际丢弃的前缀可能略多于
 * `raw.length - maxBytes`。
 */
function utf8TailWithin(raw: Uint8Array, maxBytes: number): [Uint8Array, number] {
  if (maxBytes <= 0) return [new Uint8Array(0), raw.length];
  if (raw.length <= maxBytes) return [raw, 0];
  let start = raw.length - maxBytes;
  start = utf8CharStart(raw, start);
  let tail = raw.subarray(start);
  if (tail.length > maxBytes) {
    const end = utf8SafeEnd(tail, maxBytes);
    let start2 = raw.length - end;
    start2 = utf8CharStart(raw, start2);
    tail = raw.subarray(start2);
    start = start2;
  }
  return [tail, start];
}
