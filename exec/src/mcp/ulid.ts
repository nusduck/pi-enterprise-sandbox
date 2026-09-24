/**
 * Crockford Base32 ULID，无外部依赖。移植自 `sandbox/mcp/ulid.py`。
 *
 * 与正式域 ID 兼容：26 个大写 Crockford 字符。不是 UUID，也永远不会产生
 * `exec_...` 前缀。同一毫秒内单调递增——靠对熵值加一，而不是重新取随机数，
 * 这样同毫秒内产生的多个 ID 仍然保持可排序。
 *
 * ## Model Experience
 * 模型看不到这个模块。它产出的 ID 会作为 `context_id` / `artifact_id` 出现在
 * 工具结果里，26 字符固定长度，对 token 与 KV cache 的影响是常量。
 *
 * ## Known Limitations and Deferred Work
 * - 单进程内单调。多进程下不同进程可能在同一毫秒产出不同熵值的 ID，这不影响
 *   唯一性（80 位熵），只影响跨进程的严格排序。
 */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 熵为 80 位（10 字节）；时间部分 48 位（毫秒）。 */
const RANDOM_BYTES = 10;

let lastMs = -1;
let lastRandom: Uint8Array | null = null;

function encodeTime(ms: number): string {
  if (ms < 0 || ms >= 2 ** 48) throw new RangeError('ULID time component out of range');
  const chars = new Array<string>(10);
  let rest = BigInt(ms);
  for (let i = 9; i >= 0; i -= 1) {
    chars[i] = CROCKFORD[Number(rest & 0x1fn)] as string;
    rest >>= 5n;
  }
  return chars.join('');
}

function encodeRandom(raw: Uint8Array): string {
  if (raw.length !== RANDOM_BYTES) throw new RangeError('ULID entropy must be 10 bytes');
  let n = 0n;
  for (const byte of raw) n = (n << 8n) | BigInt(byte);
  const chars = new Array<string>(16);
  for (let i = 15; i >= 0; i -= 1) {
    chars[i] = CROCKFORD[Number(n & 0x1fn)] as string;
    n >>= 5n;
  }
  return chars.join('');
}

/** 就地对 10 字节熵加一；溢出返回 false。 */
function incrementRandom(buf: Uint8Array): boolean {
  for (let i = buf.length - 1; i >= 0; i -= 1) {
    const byte = buf[i] as number;
    if (byte === 0xff) {
      buf[i] = 0;
      continue;
    }
    buf[i] = (byte + 1) & 0xff;
    return true;
  }
  return false;
}

function randomBytes(size: number): Uint8Array {
  const out = new Uint8Array(size);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/** 生成一个新的 ULID（同毫秒内单调，大写 Crockford）。 */
export function newUlid(): string {
  let ms = Date.now();
  if (ms > lastMs) {
    lastMs = ms;
    lastRandom = randomBytes(RANDOM_BYTES);
  } else {
    // 同一毫秒，或时钟回拨 → 熵值加一。
    if (lastRandom === null) lastRandom = randomBytes(RANDOM_BYTES);
    else if (!incrementRandom(lastRandom)) {
      throw new Error('ULID entropy exhausted within the same millisecond');
    }
    ms = lastMs;
  }
  return encodeTime(ms) + encodeRandom(lastRandom);
}
