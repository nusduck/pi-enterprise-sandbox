/**
 * 预算受限的 find / grep，限定在一个会话工作区内。
 * 移植自 `sandbox/services/file_search.py` 的 `FileSearchService`。
 *
 * 两条不变量，逐条对应 Python 原版，改动前先想清楚：
 *
 * 1. **绝不返回物理路径。** 所有对外路径都经 `toRel()` 转成工作区相对形式；
 *    grep 的匹配行文本还要再过一次 `redactPhysicalRoots()`——文件内容里可能
 *    恰好写着物理根（比如一份日志），那也不能漏出去。
 * 2. **绝不跟随指向工作区外的符号链接。** 目录符号链接一律不下降（记
 *    `symlink_dir_skipped`），文件符号链接解析后必须仍在根内才读。
 *
 * ## Model Experience
 * 结果里的 `truncated` + `stop_reason` 是模型判断"要不要缩小范围重搜"的唯一
 * 依据；`skipped` 让被跳过的文件（二进制、过大、符号链接越界）可见，而不是
 * 静默消失——否则模型会得出"这个文件里没有"的错误结论。
 *
 * ## Known Limitations and Deferred Work
 * - 超时只在文件之间与行之间检查，单行上的正则回溯打不断（见 `predicates.ts`）。
 * - Skill 根搜索（Python 的 `SkillSearchRoots`）未移植：需要与 ADR 0006 的
 *   启用集闸门对齐，单独一轮做。
 */
import { createReadStream } from 'node:fs';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { redactPhysicalRoots } from '../fs/redact.js';
import {
  FIND_DEFAULT_LIMIT,
  FIND_DEFAULT_MAX_DEPTH,
  FIND_MAX_DEPTH,
  FIND_MAX_LIMIT,
  FIND_MAX_PATTERN_LEN,
  LS_MAX_DEPTH,
  LS_MAX_ITEMS,
  GREP_BINARY_PROBE,
  GREP_DEFAULT_LIMIT,
  GREP_MAX_CONTEXT,
  GREP_MAX_FILE_BYTES,
  GREP_MAX_LIMIT,
  GREP_MAX_TOTAL_BYTES,
  GREP_OUTPUT_MODES,
  GREP_TIMEOUT_MS,
  VALID_ENTRY_TYPES,
  clampInt,
  type EntryType,
  type GrepOutputMode,
} from './limits.js';
import { compileGrepQuery, globMatches, isBinaryBytes, SearchQueryError } from './predicates.js';
import type {
  FileSearchItem,
  FileSearchResponse,
  FileSearchSkipped,
  FileSearchStats,
  GrepMatch,
  GrepResponse,
  SearchRoot,
} from './types.js';

export { SearchQueryError };

export interface LsOptions {
  readonly depth?: number | null;
  readonly includeHidden?: boolean;
}

export interface FindOptions {
  readonly pattern?: string;
  readonly type?: string | null;
  readonly maxDepth?: number | null;
  readonly limit?: number | null;
}

export interface GrepOptions {
  readonly query: string;
  readonly glob?: string | null;
  readonly regex?: boolean;
  readonly caseSensitive?: boolean;
  readonly context?: number | null;
  readonly limit?: number | null;
  readonly outputMode?: string;
}

/** 工作区相对 POSIX 路径；绝不泄漏绝对/物理根。 */
function toRel(root: string, target: string, publicPrefix: string | null): string {
  let rel = path.relative(root, target);
  if (rel === '' || rel === '.') rel = '.';
  const posix = rel.split(path.sep).join('/');
  const relative = posix === '' ? '.' : posix;
  if (publicPrefix === null) return relative;
  return relative === '.' ? publicPrefix : `${publicPrefix}/${relative}`;
}

/** `target`（解析后）是否仍在 `root` 内。不抛。 */
async function withinRoot(root: string, target: string): Promise<boolean> {
  try {
    const resolved = await realpath(target).catch(() => path.resolve(target));
    const rel = path.relative(root, resolved);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  } catch {
    return false;
  }
}

/** 目录项按名称小写排序，读不到就当空目录。 */
async function scandirSorted(dir: string): Promise<import('node:fs').Dirent[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1));
    return entries;
  } catch {
    return [];
  }
}

async function safeLstat(target: string): Promise<import('node:fs').Stats | null> {
  try {
    return await lstat(target);
  } catch {
    return null;
  }
}

function entryTypeOf(st: import('node:fs').Stats | null): EntryType {
  if (st === null) return 'file';
  if (st.isSymbolicLink()) return 'symlink';
  if (st.isDirectory()) return 'dir';
  return 'file';
}

/** 读文件头部若干字节做二进制探测，读不到就当二进制（保守跳过）。 */
async function isBinaryFile(target: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(target, 'r');
    const buf = Buffer.alloc(GREP_BINARY_PROBE);
    const { bytesRead } = await handle.read(buf, 0, GREP_BINARY_PROBE, 0);
    return isBinaryBytes(buf.subarray(0, bytesRead));
  } catch {
    return true;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * 六字段齐全的 stats。Python 的 `FileSearchStats` 每个字段都有默认值 0，
 * 因此它的 JSON 永远带全六个键——这里用一个构造函数保证 TS 侧不会漏发。
 */
function statsOf(partial: {
  examined?: number;
  matched?: number;
  skipped?: number;
  bytesScanned?: number;
  durationMs?: number;
  depthReached?: number;
}): FileSearchStats {
  return {
    examined: partial.examined ?? 0,
    matched: partial.matched ?? 0,
    skipped: partial.skipped ?? 0,
    bytes_scanned: partial.bytesScanned ?? 0,
    duration_ms: partial.durationMs ?? 0,
    depth_reached: partial.depthReached ?? 0,
  };
}

export class FileSearchService {
  /**
   * 有界目录列举（depth ≤ 5，≤ 1000 项）。
   *
   * `includeHidden` 默认 false：点开头的条目不列。与 Python 一致——模型问
   * "这个目录里有什么"时，`.git` 那一堆是噪音，要看得显式要。
   */
  async ls(where: SearchRoot, options: LsOptions = {}): Promise<FileSearchResponse> {
    const depth = clampInt(options.depth, 1, 0, LS_MAX_DEPTH);
    const includeHidden = Boolean(options.includeHidden);
    const { root, start, publicPrefix } = where;
    const t0 = Date.now();
    const items: FileSearchItem[] = [];
    const skipped: FileSearchSkipped[] = [];
    let examined = 0;
    let depthReached = 0;
    let truncated = false;
    let stopReason: string | null = null;

    const startStat = await safeLstat(start);
    if (startStat === null) {
      return {
        items: [],
        skipped: [{ path: toRel(root, start, publicPrefix), reason: 'not_found' }],
        stats: statsOf({ skipped: 1, durationMs: Date.now() - t0 }),
        truncated: false,
        stop_reason: 'not_found',
      };
    }

    const et0 = entryTypeOf(startStat);
    const single = (): FileSearchResponse => ({
      items: [
        {
          path: toRel(root, start, publicPrefix),
          name: path.basename(start) || '.',
          type: et0,
          size: et0 === 'file' ? startStat.size : 0,
        },
      ],
      skipped: [],
      stats: statsOf({ examined: 1, matched: 1, durationMs: Date.now() - t0 }),
      truncated: false,
      stop_reason: null,
    });

    // depth 0：只列 start 自身。非目录 start 同理。
    if (depth === 0) return single();
    if (!startStat.isDirectory()) return single();

    const visit = async (dir: string, current: number): Promise<boolean> => {
      if (current > depth) return true;
      depthReached = Math.max(depthReached, current);

      for (const entry of await scandirSorted(dir)) {
        const name = entry.name;
        if (!includeHidden && name.startsWith('.')) continue;
        const child = path.join(dir, name);
        examined += 1;
        const rel = toRel(root, child, publicPrefix);

        const push = (type: EntryType, size: number): boolean => {
          items.push({ path: rel, name, type, size });
          if (items.length >= LS_MAX_ITEMS) {
            truncated = true;
            stopReason = 'item_limit';
            return false;
          }
          return true;
        };

        if (entry.isSymbolicLink()) {
          // 符号链接安全：绝不跟随越界的；作为 symlink 条目列出。
          if (!(await withinRoot(root, child))) {
            skipped.push({ path: rel, reason: 'symlink_escape' });
            continue;
          }
          const st = await safeLstat(child);
          if (!push('symlink', st?.size ?? 0)) return false;
          continue;
        }
        if (entry.isDirectory()) {
          if (!push('dir', 0)) return false;
          if (current < depth && !(await visit(child, current + 1))) return false;
        } else if (entry.isFile()) {
          const st = await safeLstat(child);
          if (!push('file', st?.size ?? 0)) return false;
        } else {
          // socket、fifo 等
          skipped.push({ path: rel, reason: 'unsupported_type' });
        }
      }
      return true;
    };

    await visit(start, 1);
    items.sort((a, b) => (a.path.toLowerCase() < b.path.toLowerCase() ? -1 : 1));

    return {
      items,
      skipped,
      stats: statsOf({
        examined,
        matched: items.length,
        skipped: skipped.length,
        durationMs: Date.now() - t0,
        depthReached,
      }),
      truncated,
      stop_reason: stopReason,
    };
  }

  /**
   * 按 glob 找文件/目录。
   *
   * `start` 自身在 depth 0 参与匹配（与 Python 一致），因此
   * `find(path='sub', pattern='sub')` 会命中目录本身。
   */
  async find(where: SearchRoot, options: FindOptions = {}): Promise<FileSearchResponse> {
    const maxDepth = clampInt(options.maxDepth, FIND_DEFAULT_MAX_DEPTH, 0, FIND_MAX_DEPTH);
    const limit = clampInt(options.limit, FIND_DEFAULT_LIMIT, 1, FIND_MAX_LIMIT);
    const typeFilter = (options.type ?? '').trim().toLowerCase() || null;
    if (typeFilter !== null && !VALID_ENTRY_TYPES.includes(typeFilter as EntryType)) {
      throw new SearchQueryError(
        `invalid type filter: ${JSON.stringify(options.type)}; expected one of ${[
          ...VALID_ENTRY_TYPES,
        ]
          .sort()
          .join(', ')}`,
      );
    }
    let pattern = typeof options.pattern === 'string' && options.pattern ? options.pattern : '*';
    if (pattern.length > FIND_MAX_PATTERN_LEN) {
      throw new SearchQueryError(`pattern exceeds max length (${FIND_MAX_PATTERN_LEN})`);
    }

    const { root, start, publicPrefix } = where;
    const t0 = Date.now();
    const items: FileSearchItem[] = [];
    const skipped: FileSearchSkipped[] = [];
    let examined = 0;
    let depthReached = 0;
    let truncated = false;
    let stopReason: string | null = null;

    const startStat = await safeLstat(start);
    if (startStat === null) {
      return {
        items: [],
        skipped: [{ path: toRel(root, start, publicPrefix), reason: 'not_found' }],
        stats: statsOf({ skipped: 1, durationMs: Date.now() - t0 }),
        truncated: false,
        stop_reason: 'not_found',
      };
    }

    /** 匹配则收录；返回 false 表示已达上限，整体停止。 */
    const consider = (child: string, name: string, et: EntryType, size: number): boolean => {
      if (typeFilter !== null && et !== typeFilter) return true;
      const rel = toRel(root, child, publicPrefix);
      if (!globMatches(pattern, name, rel)) return true;
      items.push({ path: rel, name, type: et, size });
      if (items.length >= limit) {
        truncated = true;
        stopReason = 'item_limit';
        return false;
      }
      return true;
    };

    const finish = (): FileSearchResponse => {
      items.sort((a, b) => (a.path.toLowerCase() < b.path.toLowerCase() ? -1 : 1));
      return {
        items,
        skipped,
        stats: statsOf({
          examined,
          matched: items.length,
          skipped: skipped.length,
          durationMs: Date.now() - t0,
          depthReached,
        }),
        truncated,
        stop_reason: stopReason,
      };
    };

    const et0 = entryTypeOf(startStat);
    examined += 1;
    if (!consider(start, path.basename(start) || '.', et0, et0 === 'file' ? startStat.size : 0)) {
      return finish();
    }

    const visit = async (dir: string, depth: number): Promise<boolean> => {
      if (depth > maxDepth) return true;
      depthReached = Math.max(depthReached, depth);

      for (const entry of await scandirSorted(dir)) {
        const child = path.join(dir, entry.name);
        examined += 1;
        const rel = toRel(root, child, publicPrefix);

        if (entry.isSymbolicLink()) {
          if (!(await withinRoot(root, child))) {
            skipped.push({ path: rel, reason: 'symlink_escape' });
            continue;
          }
          const st = await safeLstat(child);
          if (!consider(child, entry.name, 'symlink', st?.size ?? 0)) return false;
          // 绝不下降进符号链接目录。
          continue;
        }

        if (entry.isDirectory()) {
          if (!consider(child, entry.name, 'dir', 0)) return false;
          if (depth < maxDepth && !(await visit(child, depth + 1))) return false;
        } else if (entry.isFile()) {
          const st = await safeLstat(child);
          if (!consider(child, entry.name, 'file', st?.size ?? 0)) return false;
        } else {
          skipped.push({ path: rel, reason: 'unsupported_type' });
        }
      }
      return true;
    };

    if (et0 === 'dir' && maxDepth >= 1) await visit(start, 1);
    return finish();
  }

  /** 文本搜索。预算与跳过原因逐条对应 Python 版。 */
  async grep(where: SearchRoot, options: GrepOptions): Promise<GrepResponse> {
    const outputMode = (options.outputMode ?? 'content') as GrepOutputMode;
    if (!GREP_OUTPUT_MODES.includes(outputMode)) {
      throw new SearchQueryError(
        `invalid output_mode: ${JSON.stringify(options.outputMode)}; expected one of ${[
          ...GREP_OUTPUT_MODES,
        ]
          .sort()
          .join(', ')}`,
      );
    }
    const contextN = clampInt(options.context, 0, 0, GREP_MAX_CONTEXT);
    const limitN = clampInt(options.limit, GREP_DEFAULT_LIMIT, 1, GREP_MAX_LIMIT);
    const pattern = compileGrepQuery(options.query, {
      regex: Boolean(options.regex),
      caseSensitive: options.caseSensitive !== false,
    });
    const globPat =
      typeof options.glob === 'string' && options.glob.trim() ? options.glob.trim() : null;
    if (globPat !== null && globPat.length > 256) {
      throw new SearchQueryError('glob exceeds max length (256)');
    }

    const { root, start, publicPrefix } = where;
    const t0 = Date.now();
    const deadline = t0 + GREP_TIMEOUT_MS;
    const matches: GrepMatch[] = [];
    const skipped: FileSearchSkipped[] = [];
    let examined = 0;
    let bytesScanned = 0;
    let truncated = false;
    let stopReason: string | null = null;

    const budgetOk = (): boolean => {
      if (Date.now() >= deadline) {
        truncated = true;
        stopReason = 'timeout';
        return false;
      }
      if (bytesScanned >= GREP_MAX_TOTAL_BYTES) {
        truncated = true;
        stopReason = 'scan_budget';
        return false;
      }
      if (matches.length >= limitN) {
        truncated = true;
        stopReason = 'match_limit';
        return false;
      }
      return true;
    };

    const globOk = (name: string, rel: string): boolean =>
      globPat === null || globMatches(globPat, name, rel);

    /** 扫一个文件。返回 false 表示整体搜索中止。 */
    const scanFile = async (filePath: string): Promise<boolean> => {
      if (!budgetOk()) return false;
      const rel = toRel(root, filePath, publicPrefix);
      examined += 1;

      let target = filePath;
      const linkStat = await safeLstat(filePath);
      if (linkStat?.isSymbolicLink()) {
        if (!(await withinRoot(root, filePath))) {
          skipped.push({ path: rel, reason: 'symlink_escape' });
          return true;
        }
        try {
          target = await realpath(filePath);
        } catch {
          skipped.push({ path: rel, reason: 'symlink_error' });
          return true;
        }
        if (!(await withinRoot(root, target))) {
          skipped.push({ path: rel, reason: 'symlink_escape' });
          return true;
        }
      }

      let st;
      try {
        st = await stat(target);
      } catch {
        skipped.push({ path: rel, reason: 'stat_error' });
        return true;
      }
      if (!st.isFile()) return true;
      if (st.size > GREP_MAX_FILE_BYTES) {
        skipped.push({ path: rel, reason: 'file_too_large' });
        return true;
      }
      if (await isBinaryFile(target)) {
        skipped.push({ path: rel, reason: 'binary' });
        return true;
      }

      let raw: Buffer;
      try {
        raw = await readCapped(target, GREP_MAX_FILE_BYTES + 1);
      } catch {
        skipped.push({ path: rel, reason: 'read_error' });
        return true;
      }
      if (raw.byteLength > GREP_MAX_FILE_BYTES) {
        skipped.push({ path: rel, reason: 'file_too_large' });
        return true;
      }

      bytesScanned += raw.byteLength;
      if (bytesScanned > GREP_MAX_TOTAL_BYTES) {
        truncated = true;
        stopReason = 'scan_budget';
        return false;
      }

      const lines = raw.toString('utf8').split(/\r\n|\r|\n/);
      if (outputMode === 'content') {
        for (let idx = 0; idx < lines.length; idx += 1) {
          if (!budgetOk()) return false;
          const line = lines[idx] as string;
          pattern.lastIndex = 0;
          const m = pattern.exec(line);
          if (m === null) continue;
          matches.push({
            path: rel,
            line: idx + 1,
            column: m.index + 1,
            text: line,
            before: contextN ? lines.slice(Math.max(0, idx - contextN), idx) : [],
            after: contextN ? lines.slice(idx + 1, idx + 1 + contextN) : [],
          });
          if (matches.length >= limitN) {
            truncated = true;
            stopReason = 'match_limit';
            return false;
          }
        }
        return true;
      }

      // files_with_matches / count：行文本不出这个函数，所以 context 无意义，
      // 且 files_with_matches 命中第一处就能停，不必扫完整个文件。
      let firstLine = 0;
      let firstColumn = 1;
      let fileMatchCount = 0;
      for (let idx = 0; idx < lines.length; idx += 1) {
        pattern.lastIndex = 0;
        const m = pattern.exec(lines[idx] as string);
        if (m === null) continue;
        fileMatchCount += 1;
        if (firstLine === 0) {
          firstLine = idx + 1;
          firstColumn = m.index + 1;
        }
        if (outputMode === 'files_with_matches') break;
      }
      if (fileMatchCount === 0) return true;
      if (!budgetOk()) return false;
      matches.push({
        path: rel,
        line: firstLine,
        column: firstColumn,
        text: '',
        before: [],
        after: [],
        ...(outputMode === 'count' ? { count: fileMatchCount } : {}),
      });
      if (matches.length >= limitN) {
        truncated = true;
        stopReason = 'match_limit';
        return false;
      }
      return true;
    };

    const startStat = await safeLstat(start);
    if (startStat === null) {
      return {
        matches: [],
        skipped: [{ path: toRel(root, start, publicPrefix), reason: 'not_found' }],
        stats: statsOf({ skipped: 1, durationMs: Date.now() - t0 }),
        truncated: false,
        stop_reason: 'not_found',
      };
    }

    if (!startStat.isDirectory()) {
      if (globOk(path.basename(start), toRel(root, start, publicPrefix))) await scanFile(start);
    } else {
      await this.#walk(start, root, publicPrefix, skipped, budgetOk, globOk, scanFile);
    }

    matches.sort((a, b) => {
      const pa = a.path.toLowerCase();
      const pb = b.path.toLowerCase();
      if (pa !== pb) return pa < pb ? -1 : 1;
      if (a.line !== b.line) return a.line - b.line;
      return a.column - b.column;
    });

    // 防御性：文件内容里可能恰好写着物理根，匹配行也要脱敏。
    for (const m of matches) {
      m.text = redactPhysicalRoots(m.text, [root]);
      m.before = m.before.map((b) => redactPhysicalRoots(b, [root]));
      m.after = m.after.map((a) => redactPhysicalRoots(a, [root]));
    }

    return {
      matches,
      skipped,
      stats: statsOf({
        examined,
        matched: matches.length,
        skipped: skipped.length,
        bytesScanned,
        durationMs: Date.now() - t0,
      }),
      truncated,
      stop_reason: stopReason,
    };
  }

  /** 不跟随符号链接的深度优先遍历，目录符号链接与越界目录一律剪掉。 */
  async #walk(
    dir: string,
    root: string,
    publicPrefix: string | null,
    skipped: FileSearchSkipped[],
    budgetOk: () => boolean,
    globOk: (name: string, rel: string) => boolean,
    scanFile: (p: string) => Promise<boolean>,
  ): Promise<boolean> {
    if (!budgetOk()) return false;
    const entries = await scandirSorted(dir);

    // 与 Python `os.walk` 的分类一致：指向文件的符号链接归入 filenames（交给
    // `scanFile` 自己做越界判断并记 skipped），指向目录的归入 dirnames（随后
    // 被剪掉并记 `symlink_dir_skipped`）。
    //
    // 早前这里写的是 `entry.isFile()`，而 Dirent 对符号链接返回 false，于是
    // **所有**符号链接既不被扫描也不被记录——内容确实没泄漏，但模型看不到
    // 它被跳过了，而且指向工作区内部的符号链接也被无声丢掉，是功能回归。
    const files: string[] = [];
    const dirs: string[] = [];
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        // 用 follow 的 stat 判断链接目标是不是目录；解析不了就当文件候选，
        // 由 `scanFile` 的 symlink_error 分支报告。
        const targetStat = await stat(child).catch(() => null);
        if (targetStat?.isDirectory()) dirs.push(entry.name);
        else files.push(entry.name);
        continue;
      }
      if (entry.isDirectory()) dirs.push(entry.name);
      else if (entry.isFile()) files.push(entry.name);
    }

    for (const name of files) {
      if (!budgetOk()) return false;
      const fpath = path.join(dir, name);
      if (!globOk(name, toRel(root, fpath, publicPrefix))) continue;
      if (!(await scanFile(fpath))) return false;
    }
    for (const name of dirs) {
      const dpath = path.join(dir, name);
      const st = await safeLstat(dpath);
      if (st?.isSymbolicLink()) {
        skipped.push({ path: toRel(root, dpath, publicPrefix), reason: 'symlink_dir_skipped' });
        continue;
      }
      if (!(await withinRoot(root, dpath))) {
        skipped.push({ path: toRel(root, dpath, publicPrefix), reason: 'path_escape' });
        continue;
      }
      if (!(await this.#walk(dpath, root, publicPrefix, skipped, budgetOk, globOk, scanFile))) {
        return false;
      }
    }
    return true;
  }
}

/** 最多读 `cap` 字节，不把超大文件整个吸进内存。 */
async function readCapped(target: string, cap: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  const stream = createReadStream(target, { start: 0, end: cap - 1 });
  for await (const chunk of stream) {
    const buf = chunk as Buffer;
    chunks.push(buf);
    total += buf.byteLength;
    if (total >= cap) break;
  }
  stream.destroy();
  return Buffer.concat(chunks, Math.min(total, cap));
}

export const fileSearchService = new FileSearchService();
