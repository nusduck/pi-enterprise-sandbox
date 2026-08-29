/**
 * 危险命令硬拒——移植自 `sandbox/services/policy_checker.py` 的
 * `ToolPolicyChecker.is_blocked_command()`（连同它依赖的 `_shell_segments()`
 * 小型 shell 解析器与一批常量集合）。
 *
 * 为什么要在 exec 侧而不是只留在 Agent 侧策略层：ADR 0007 D11 —— Bubblewrap /
 * exec 是唯一的安全边界。Agent 侧的 `runtime/src/policy/pre-execute.ts`
 * 未来会跑一份类似的风险分级（`ToolPolicyChecker.check()` 的 allow/hard_deny
 * 那一半），但那是"要不要审批"的产品层判断，可以被绕过、可以被将来的重构
 * 删掉。这里是最后一道闸门：不管调用方是谁、有没有先过一遍策略检查，
 * `exec/` 自己在真正 spawn 之前**必须**再挡一次，挡的判据与今天 Python 版
 * 的 `is_blocked_command()` 完全一致（这就是"移植"的范围——`check()` 里
 * 风险分级、审批那一套是产品层逻辑，不搬）。
 *
 * 本文件只做**判断**，不做拒绝后的响应格式化——那是 `executor.ts` 的职责
 * （拒绝时 `run()`/`start()` 必须 resolve 而不是 reject，因为这是"这次调用的
 * 结果"，不是"基础设施故障"，见 dsh-shell README 的 run()/start() 契约）。
 *
 * 这不是一个真正的 shell 解释器（上游注释原话："a small policy parser, not
 * a shell interpreter"）。遇到任何解析不确定的情况一律 fail-closed（当作
 * 危险命令拒绝），这条纪律在移植时逐条保留。
 */

/** 直接前缀命中即拒绝——对应 Python 版 `_BLOCKED_COMMAND_PREFIXES`。 */
const BLOCKED_COMMAND_PREFIXES: readonly string[] = [
  'sudo',
  'su ',
  'chmod 777',
  'chown ',
  'rm -rf /',
  'rm -rf /*',
  'dd if=',
  'mkfs.',
  'fdisk',
  '> /dev/',
  '< /dev/',
];

const PRIVILEGE_COMMANDS = new Set(['sudo', 'su', 'doas', 'runuser']);
const NAMESPACE_COMMANDS = new Set([
  'bwrap',
  'capsh',
  'chroot',
  'mount',
  'newgidmap',
  'newuidmap',
  'nsenter',
  'pivot_root',
  'setns',
  'setpriv',
  'umount',
  'unshare',
]);
const DEVICE_COMMANDS = new Set([
  'blkdiscard',
  'blockdev',
  'fdisk',
  'insmod',
  'iptables',
  'ip6tables',
  'losetup',
  'mknod',
  'modprobe',
  'nft',
  'rmmod',
  'swapon',
  'swapoff',
]);
const CAPABILITY_COMMANDS = new Set(['setcap']);
const NETWORK_MUTATION_VERBS = new Set([
  'add',
  'append',
  'change',
  'del',
  'delete',
  'flush',
  'prepend',
  'remove',
  'replace',
  'set',
]);
const SAFE_DEVICE_NAMES = ['full', 'null', 'random', 'stderr', 'stdin', 'stdout', 'tty', 'urandom', 'zero'].sort();

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 危险的设备/伪文件系统重定向——对应 `_DANGEROUS_DEVICE_REDIRECT`。 */
const DANGEROUS_DEVICE_REDIRECT = new RegExp(
  '(?:>{1,2}|<)\\s*(?:/dev/(?!' +
    SAFE_DEVICE_NAMES.map(escapeRegExp).join('|') +
    ')(?:\\b|$))[^\\s;&|()]+|/proc/(?:sys|kcore|keys)(?:/|\\b)|/sys(?:/|\\b)',
  'i',
);

const SENSITIVE_HOST_PATHS: readonly string[] = [
  '/etc/shadow',
  '/etc/gshadow',
  '/etc/passwd-',
  '/run/secrets',
  '/var/run/secrets',
  '/var/sandbox/workspaces',
  '/var/sandbox/tmp',
  '/sandbox/workspaces',
  '/sandbox/tmp',
  '/sandbox/data',
  '/var/run/docker.sock',
];

const SENSITIVE_PROC_PATH = /\/proc\/\d+\/(?:environ|mem|syscall)(?:\b|\/)/i;

const METADATA_DESTINATIONS: readonly string[] = [
  '169.254.',
  'metadata.google.internal',
  'metadata.amazonaws.com',
  '169.254.170.2',
];

const SHELL_WRAPPERS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh']);

/** 解析失败的哨兵词——出现在结果里即等价于"拒绝"，对应 `_POLICY_PARSE_ERROR`。 */
const POLICY_PARSE_ERROR = '__policy_parse_error__';

// ── 极简 POSIX 分词（不追求逐字节对齐 Python `shlex.split(posix=True)`，
//    但保留同样的 fail-closed 意图：未闭合引号即报错，不猜测调用方意图）──

/**
 * 把一个不含 `;`/`&`/`|`/换行的 shell 片段切成 argv 风格的词列表。
 * 未闭合的引号返回 `null`（对应 Python 版 `shlex.split` 抛 `ValueError`）。
 */
function posixShellSplit(segment: string): string[] | null {
  const words: string[] = [];
  let current = '';
  let hasCurrent = false;
  let quote: '\'' | '"' | undefined;
  let i = 0;
  while (i < segment.length) {
    const ch = segment[i] as string;
    if (quote === '\'') {
      if (ch === '\'') {
        quote = undefined;
      } else {
        current += ch;
      }
      i += 1;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = undefined;
      } else if (ch === '\\' && i + 1 < segment.length && '"\\$`'.includes(segment[i + 1] as string)) {
        current += segment[i + 1];
        i += 1;
      } else {
        current += ch;
      }
      i += 1;
      continue;
    }
    if (ch === '\'' || ch === '"') {
      quote = ch;
      hasCurrent = true;
      i += 1;
      continue;
    }
    if (ch === '\\') {
      if (i + 1 >= segment.length) return null; // 行尾反斜杠：未完成的转义。
      current += segment[i + 1];
      hasCurrent = true;
      i += 2;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasCurrent) {
        words.push(current);
        current = '';
        hasCurrent = false;
      }
      i += 1;
      continue;
    }
    current += ch;
    hasCurrent = true;
    i += 1;
  }
  if (quote !== undefined) return null; // 未闭合引号。
  if (hasCurrent) words.push(current);
  return words;
}

/** 在引号之外按 `;`/`&`/`|`/换行切分顶层 shell 片段——对应 `_split_shell_segments`。 */
function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '\'' | '"' | undefined;
  let escaped = false;
  let i = 0;
  while (i < command.length) {
    const ch = command[i] as string;
    if (escaped) {
      current += ch;
      escaped = false;
      i += 1;
      continue;
    }
    if (ch === '\\' && quote === undefined) {
      current += ch;
      escaped = true;
      i += 1;
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote) quote = undefined;
      i += 1;
      continue;
    }
    if (ch === '\'' || ch === '"') {
      current += ch;
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === ';' || ch === '&' || ch === '|' || ch === '\n') {
      if ((ch === '&' || ch === '|') && i + 1 < command.length && command[i + 1] === ch) {
        i += 1;
      }
      segments.push(current);
      current = '';
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  segments.push(current);
  return segments;
}

/**
 * 递归解析出每个顶层片段的 argv 词列表——对应 `_shell_segments`。
 * 认识 `command` / `exec` / `env` / `timeout` / shell 包装器（`sh -c` 等）
 * 这几种常见的开发工具包装写法，看不懂的选项一律产出解析失败哨兵。
 */
function shellSegments(command: string, depth = 0): string[][] {
  if (depth > 8) return [[POLICY_PARSE_ERROR]];
  const segments = splitShellSegments(command);
  const parsed: string[][] = [];

  for (const segment of segments) {
    const split = posixShellSplit(segment);
    let words: string[] = split ?? [POLICY_PARSE_ERROR];

    outer: while (words.length > 0) {
      const first = words[0] as string;
      if (first.includes('=') && !first.startsWith('/') && !first.startsWith('./')) {
        words.shift();
        continue;
      }
      const executable = (first.split('/').pop() ?? first).toLowerCase();

      if (executable === 'command') {
        words.shift();
        while (words.length > 0 && words[0] !== '--' && (words[0] as string).startsWith('-')) {
          if (words.shift() !== '-p') {
            parsed.push([POLICY_PARSE_ERROR]);
            words = [];
            break outer;
          }
        }
        if (words[0] === '--') words.shift();
        continue;
      }

      if (executable === 'exec') {
        words.shift();
        while (words.length > 0 && words[0] !== '--' && (words[0] as string).startsWith('-')) {
          const option = words.shift() as string;
          if (option === '-a') {
            if (words.length === 0) {
              parsed.push([POLICY_PARSE_ERROR]);
              words = [];
              break outer;
            }
            words.shift();
          } else if (option.startsWith('-a') && option.length > 2) {
            continue;
          } else if (option.startsWith('-') && [...option.slice(1)].every((c) => c === 'c' || c === 'l')) {
            continue;
          } else {
            parsed.push([POLICY_PARSE_ERROR]);
            words = [];
            break outer;
          }
        }
        if (words[0] === '--') words.shift();
        continue;
      }

      if (executable === 'env') {
        words.shift();
        while (words.length > 0) {
          if (words[0] === '--') {
            words.shift();
            break;
          }
          const head = words[0] as string;
          if (head.includes('=') && !head.startsWith('-')) {
            words.shift();
            continue;
          }
          if (!head.startsWith('-')) break;
          const option = words.shift() as string;
          if (option === '-u' || option === '--unset' || option === '-C' || option === '--chdir' ||
              option === '-S' || option === '--split-string') {
            if (words.length === 0) {
              parsed.push([POLICY_PARSE_ERROR]);
              words = [];
              break outer;
            }
            const value = words.shift() as string;
            if (option === '-S' || option === '--split-string') {
              parsed.push(...shellSegments(value, depth + 1));
            }
          } else if (
            option.startsWith('-u') || option.startsWith('--unset=') ||
            option.startsWith('-C') || option.startsWith('--chdir=')
          ) {
            continue;
          } else if (option.startsWith('-S')) {
            parsed.push(...shellSegments(option.slice(2), depth + 1));
          } else if (option.startsWith('--split-string=')) {
            parsed.push(...shellSegments(option.split('=').slice(1).join('='), depth + 1));
          } else if (option === '-i' || option === '--ignore-environment' || option === '-0' || option === '--null') {
            continue;
          } else {
            parsed.push([POLICY_PARSE_ERROR]);
            words = [];
            break outer;
          }
        }
        continue;
      }

      if (executable === 'timeout') {
        words.shift();
        while (words.length > 0 && words[0] !== '--' && (words[0] as string).startsWith('-')) {
          const option = words.shift() as string;
          if (option === '-k' || option === '-s' || option === '--kill-after' || option === '--signal') {
            if (words.length === 0) {
              parsed.push([POLICY_PARSE_ERROR]);
              words = [];
              break outer;
            }
            words.shift();
          } else if (
            option.startsWith('-k') || option.startsWith('-s') ||
            option.startsWith('--kill-after=') || option.startsWith('--signal=')
          ) {
            continue;
          } else if (option === '--preserve-status' || option === '--foreground' || option === '--verbose') {
            continue;
          } else {
            parsed.push([POLICY_PARSE_ERROR]);
            words = [];
            break outer;
          }
        }
        if (words[0] === '--') words.shift();
        if (words.length > 0) {
          words.shift(); // duration, e.g. 10 or 1m
        } else {
          parsed.push([POLICY_PARSE_ERROR]);
          break;
        }
        continue;
      }

      if (SHELL_WRAPPERS.has(executable)) {
        words.shift();
        let payload: string | undefined;
        let shellError = false;
        while (words.length > 0) {
          const option = words.shift() as string;
          if (option === '-c') {
            if (words.length === 0) {
              shellError = true;
            } else {
              payload = words.shift();
            }
            break;
          }
          if (option.startsWith('-')) {
            if (['-e', '-i', '-l', '-s', '-u', '-v', '-x', '-f'].includes(option)) {
              continue;
            }
            if (option === '-o' || option === '+o') {
              if (words.length === 0) {
                shellError = true;
                break;
              }
              words.shift();
              continue;
            }
            const rest = option.slice(1);
            const allowed = new Set(['c', 'e', 'i', 'l', 's', 'u', 'v', 'x', 'f']);
            if (option.startsWith('-') && rest.includes('c') && [...rest].every((c) => allowed.has(c))) {
              if (words.length === 0) {
                shellError = true;
              } else {
                payload = words.shift();
              }
              break;
            }
            shellError = true;
            break;
          }
          // 脚本路径对这个"只识别命令"的解析器是不透明的。
          break;
        }
        if (shellError) {
          parsed.push([POLICY_PARSE_ERROR]);
        } else if (payload !== undefined) {
          parsed.push(...shellSegments(payload, depth + 1));
        }
        words = [];
        break outer;
      }

      break outer;
    }

    if (words.length > 0) {
      parsed.push(words);
    }
  }
  return parsed;
}

function isCapabilityOrNetworkMutation(executable: string, args: readonly string[]): boolean {
  if (executable === 'setcap') return true;
  const lowered = args.map((a) => a.toLowerCase());
  if (executable === 'ip' || executable === 'ip6') {
    return lowered.includes('netns') || lowered.some((arg) => NETWORK_MUTATION_VERBS.has(arg));
  }
  if (executable === 'sysctl') {
    return lowered.some(
      (arg) => arg === '-w' || arg === '--write' || arg === '-p' || arg === '--system' ||
        arg.startsWith('--write=') || arg.includes('='),
    );
  }
  return false;
}

/**
 * 硬拒判定——对应 `ToolPolicyChecker.is_blocked_command()`。
 *
 * 命中即拒绝，不做风险分级、不判断能不能审批——这就是"硬拒绝"的含义：
 * 在任何审批流程之前就结束这次调用。调用方（`executor.ts`）负责把
 * `true` 转换成一个 `resolve()` 而不是 `reject()` 的结果（这是"这次命令
 * 被拒绝"的结果，不是"基础设施坏了"）。
 */
export function isBlockedCommand(command: string): boolean {
  const cmd = (command ?? '').trim();
  if (!cmd) return false;
  const lowered = cmd.toLowerCase();

  if (BLOCKED_COMMAND_PREFIXES.some((prefix) => lowered.startsWith(prefix))) return true;
  if (SENSITIVE_HOST_PATHS.some((path) => lowered.includes(path))) return true;
  if (SENSITIVE_PROC_PATH.test(lowered) || DANGEROUS_DEVICE_REDIRECT.test(cmd)) return true;
  if (METADATA_DESTINATIONS.some((destination) => lowered.includes(destination))) return true;

  for (const words of shellSegments(cmd)) {
    if (words.length > 0 && words[0] === POLICY_PARSE_ERROR) return true;
    const first = words[0] as string;
    const executable = (first.split('/').pop() ?? first).toLowerCase();
    const args = words.slice(1).map((w) => w.toLowerCase());

    if (
      PRIVILEGE_COMMANDS.has(executable) ||
      NAMESPACE_COMMANDS.has(executable) ||
      DEVICE_COMMANDS.has(executable) ||
      CAPABILITY_COMMANDS.has(executable)
    ) {
      return true;
    }
    if (isCapabilityOrNetworkMutation(executable, args)) return true;
    if (executable === 'chmod' && args.some((arg) => arg === '777')) return true;
    if (executable === 'chown') return true;
    if (executable === 'dd' && args.some((arg) => arg.startsWith('if='))) return true;
    if (executable === 'mkfs' || executable.startsWith('mkfs.') || executable === 'fdisk' || executable === 'parted') {
      return true;
    }
    if (executable === 'rm') {
      const recursive = args.some((arg) => arg.startsWith('-') && arg.includes('r'));
      const targetsRoot = args.some((arg) => arg === '/' || arg === '/*' || arg === '--no-preserve-root');
      if (recursive && targetsRoot) return true;
    }
  }
  return false;
}
