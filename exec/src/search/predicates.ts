/**
 * 搜索用到的纯谓词：二进制探测、glob 匹配、正则编译。
 * 移植自 `sandbox/services/file_search.py` 的同名私有函数。
 *
 * 单独成文件是因为这几条是搜索面**最容易被悄悄改松**的地方：二进制探测放松
 * 一点，乱码就进模型上下文；不安全正则表放松一点，一次 grep 就能挂住进程。
 * 放在一起才好逐条对照 Python 原版审。
 *
 * ## Model Experience
 * `isBinaryBytes` 决定哪些文件根本不会出现在 grep 结果里——被跳过的文件会以
 * `skipped: [{path, reason: 'binary'}]` 的形式告诉模型，而不是静默消失，
 * 否则模型会以为那个文件里确实没有它要找的东西。
 *
 * ## Known Limitations and Deferred Work
 * - `globMatches` 用 Python `fnmatch` 的语义，其中 `*` **会**跨越 `/`。
 *   所以 `src/*.ts` 也能匹配 `src/a/b.ts`。这与 shell glob 不同，但与
 *   Python 版逐字节一致，改它会让既有调用方的结果变化。
 */
import { GREP_MAX_PATTERN_LEN } from './limits.js';

/**
 * 常见会导致灾难性回溯的构造；`regex: true` 时拒绝。
 * 逐字节移植自 Python 的 `_UNSAFE_REGEX`，顺序与分支都不要改。
 */
const UNSAFE_REGEX = new RegExp(
  '(' +
    '\\(\\?[#=!:<]' + // lookaround / 命名组 / 注释
    '|\\\\[0-9]{2,}' + // 大编号反向引用
    '|(\\.\\*){3,}' + // 连续的 .*
    '|(\\+\\+|\\*\\*|\\\\s\\+|\\\\S\\+)' + // 占有式/叠加量词
    '|\\{\\d+,\\}' + // 开放上界量词
    '|\\([^)]*[+*][^)]*\\)[+*{]' + // 嵌套量词，例如 (a+)+ 或 (.*)*
    ')',
);

/**
 * 二进制判定。
 *
 * 两条规则，与 Python 一致：含 NUL 直接判定；否则按"非文本控制字节"占比 > 30%。
 * 空内容**不是**二进制（否则空文件会被无谓跳过）。
 */
export function isBinaryBytes(sample: Uint8Array): boolean {
  if (sample.length === 0) return false;
  let nontext = 0;
  for (const b of sample) {
    if (b === 0) return true;
    // b < 9，或 13 < b < 32 且不是 ESC(27)，或 DEL(0x7f)
    if (b < 9 || (b > 13 && b < 32 && b !== 27) || b === 0x7f) nontext += 1;
  }
  return nontext / sample.length > 0.3;
}

/** 正则元字符转义，等价 Python `re.escape` 对本场景的效果。 */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class SearchQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SearchQueryError';
  }
}

/**
 * 编译 grep 查询。
 *
 * `regex: false`（默认）走字面量：整串转义，所以用户搜 `a.b` 不会意外匹配到
 * `axb`。`regex: true` 先过不安全构造表再编译。
 */
export function compileGrepQuery(
  query: string,
  options: { regex: boolean; caseSensitive: boolean },
): RegExp {
  if (typeof query !== 'string' || query === '') {
    throw new SearchQueryError('query is required');
  }
  if (query.length > GREP_MAX_PATTERN_LEN) {
    throw new SearchQueryError(`query exceeds max length (${GREP_MAX_PATTERN_LEN})`);
  }
  const flags = options.caseSensitive ? '' : 'i';
  if (!options.regex) return new RegExp(escapeRegex(query), flags);

  if (UNSAFE_REGEX.test(query)) {
    throw new SearchQueryError('regex pattern rejected: potentially unsafe construct');
  }
  try {
    return new RegExp(query, flags);
  } catch (err) {
    throw new SearchQueryError(`invalid regex: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 把一个 `fnmatch` 风格的 glob 翻成正则。
 *
 * Python `fnmatch.translate` 的语义：`*` → `.*`（**跨 `/`**）、`?` → `.`、
 * `[seq]` → 字符类（`[!seq]` 是取反），其余字符转义。
 */
function globToRegExp(pattern: string, flags: string): RegExp {
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i] as string;
    i += 1;
    if (ch === '*') {
      out += '.*';
    } else if (ch === '?') {
      out += '.';
    } else if (ch === '[') {
      // 找到收尾的 ']'；找不到就把 '[' 当字面量。
      let j = i;
      if (j < pattern.length && (pattern[j] === '!' || pattern[j] === '^')) j += 1;
      if (j < pattern.length && pattern[j] === ']') j += 1;
      while (j < pattern.length && pattern[j] !== ']') j += 1;
      if (j >= pattern.length) {
        out += '\\[';
      } else {
        let body = pattern.slice(i, j);
        i = j + 1;
        if (body.startsWith('!')) body = `^${body.slice(1)}`;
        // 字符类里只需要转义反斜杠，其余按 POSIX 类语义原样保留。
        out += `[${body.replace(/\\/g, '\\\\')}]`;
      }
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`, flags);
}

function fnmatch(candidate: string, pattern: string): boolean {
  return globToRegExp(pattern, '').test(candidate);
}

/**
 * 把 find/grep 的 glob 匹配到 basename，或——当调用方写了带路径的 pattern
 * （含 `/`）——匹配到工作区相对路径。
 *
 * 朴素 pattern（`*.py`、`test_*.py`）匹配 basename，所以不需要调用方写双星加
 * 斜杠前缀就能在整棵树里找到文件——遍历本身已经在递归了。含 `/` 的 pattern
 * （形如 `src/` 加双星加 `/*.ts`）改为匹配相对路径，这样一个确实想按目录限定范围的调用方
 * 不会收到一个空的、无从解释的结果。开头的 `/` 会被剥掉，因为调用方可能把
 * pattern 想成"相对工作区根"，而遍历本身从不产出以 `/` 开头的路径。
 */
export function globMatches(pattern: string, name: string, rel: string): boolean {
  let candidate: string;
  let globPattern: string;
  if (pattern.includes('/')) {
    candidate = rel;
    globPattern = pattern.replace(/^\/+/, '');
  } else {
    candidate = name;
    globPattern = pattern;
  }
  return (
    fnmatch(candidate, globPattern) || fnmatch(candidate.toLowerCase(), globPattern.toLowerCase())
  );
}
