/**
 * 搜索的硬上限。移植自 `sandbox/services/file_search.py` 的常量段。
 *
 * **调用方只能收紧，不能放宽**——`clampInt` 无条件把入参夹到 [lo, hi]，
 * 所以一个 `limit: 10^9` 的请求不会变成一次无界扫描，而是被静默夹到上限。
 * 这条是搜索面唯一的资源保护，去掉它模型就能用一次 grep 打满整个进程。
 *
 * ## Model Experience
 * 模型看不到这些数字，看到的是结果里的 `truncated: true` 与 `stop_reason`
 * （`item_limit` / `match_limit` / `scan_budget` / `timeout`）。这几个值告诉
 * 它"结果不完整、该缩小范围再搜一次"，而不是让它以为搜完了——这是把
 * "预算耗尽"和"确实没有更多结果"区分开的唯一手段。
 *
 * ## Known Limitations and Deferred Work
 * - 超时是软的：只在文件之间与行之间检查，单个正则在单行上的灾难性回溯
 *   不会被打断。`compileGrepQuery()` 的不安全构造拒绝表是对这一条的补偿。
 */

export const LS_MAX_ITEMS = 1000;
export const LS_MAX_DEPTH = 5;

export const FIND_DEFAULT_MAX_DEPTH = 20;
export const FIND_MAX_DEPTH = 20;
export const FIND_DEFAULT_LIMIT = 500;
export const FIND_MAX_LIMIT = 500;
export const FIND_MAX_PATTERN_LEN = 256;

export const GREP_DEFAULT_LIMIT = 500;
export const GREP_MAX_LIMIT = 500;
export const GREP_MAX_CONTEXT = 5;
export const GREP_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const GREP_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
export const GREP_TIMEOUT_MS = 5_000;
export const GREP_BINARY_PROBE = 8192;
export const GREP_MAX_PATTERN_LEN = 512;

export const GREP_OUTPUT_MODES = ['content', 'files_with_matches', 'count'] as const;
export type GrepOutputMode = (typeof GREP_OUTPUT_MODES)[number];

export const VALID_ENTRY_TYPES = ['file', 'dir', 'symlink'] as const;
export type EntryType = (typeof VALID_ENTRY_TYPES)[number];

/**
 * 夹到 [lo, hi]，非法输入取 default。
 *
 * 注意"非法就取 default"而不是"非法就抛"：Python 版如此，且这是对的——
 * 一个手滑传了 `limit: "abc"` 的调用应该拿到默认预算的结果，而不是一条错误。
 */
export function clampInt(value: unknown, fallback: number, lo: number, hi: number): number {
  if (value === null || value === undefined) return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}
