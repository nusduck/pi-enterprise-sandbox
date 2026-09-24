/**
 * 宿主环境变量过滤——移植自 `sandbox/security/safe_env.py`。
 *
 * 这是 W1-C 交回来的缺口（见 `exec/src/isolation/build.ts` 顶部注释）：
 * `buildIsolationProfile()` 刻意不读 `process.env`，只在调用方给的
 * `envOverrides` 之上叠加隔离层自己必须保证的键（`HOME`/`PWD`/`TMPDIR`/
 * `XDG_*`，见 `build.ts` 的 `EnvPlan` 构造）。"把宿主 env 洗干净，产出一份
 * 可以放心塞进 `envOverrides` 的 `Record<string,string>`"是这个文件的职责。
 *
 * 三层合并顺序（后面覆盖前面），与 Python 版 `safe_env()` 完全一致：
 *
 * 1. 本执行器自带的最小安全默认值（`PATH`/`LANG`/…）——**不包含** `HOME`/
 *    `PWD`：那两个键的值必须是沙箱内的逻辑路径，只有 `build.ts` 知道怎么
 *    算，这里给了也会被 `build.ts` 的 `EnvPlan` 无条件覆盖（`envOverrides`
 *    在对象展开时排在前面）——为了不让人误以为这里设的值生效，干脆不设。
 * 2. 共享执行环境：显式允许清单 + `SANDBOX_EXEC_ENV_*` 前缀透传，两者都过
 *    硬编码拒绝清单（服务凭据类的键名/子串，即使被允许清单点名也不放行）。
 * 3. 每次调用的 `overrides`（优先级最高，但仍然挡精确名字匹配的服务凭据）。
 *
 * 子进程**从不**继承宿主完整 `process.env`——这是这个模块存在的全部意义。
 */

/** `SANDBOX_EXEC_ENV_FOO=bar` → 每次执行的子进程里都会有 `FOO=bar`。 */
export const EXEC_ENV_PREFIX = 'SANDBOX_EXEC_ENV_';

/** 合法的类 POSIX 环境变量名——与 `render.ts` 里 bwrap `--setenv` 的校验一致。 */
import { AGENT_PYTHON_VENV } from '../isolation/profile.js';

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 本执行器的最小安全默认值——对应 Python 版 `_BASE_SAFE_ENV`，**去掉了**
 * `HOME`（原版本身就是 `""`，注释写着"overridden per-execution"，这里干脆
 * 不放）。`PWD` 同理不放，都交给 `build.ts` 的 `EnvPlan` 决定。
 */
export const BASE_SAFE_ENV: Readonly<Record<string, string>> = {
  PATH: `${AGENT_PYTHON_VENV}/bin:/usr/local/bin:/usr/bin:/bin`,
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  PYTHONIOENCODING: 'utf-8',
  NODE_OPTIONS: '--max-old-space-size=512',
  // 内置的办公/幻灯片 JS 包装在镜像的全局 Node 模块树里；只暴露这条非敏感
  // 工具路径给子进程。
  NODE_PATH: '/usr/local/lib/node_modules',
  // Debian 的 Chromium 启动器要 source /etc/chromium.d，这在刻意精简的
  // Bubblewrap /etc 视图之外。镜像里的包装脚本直接调用真正的二进制；
  // Bubblewrap 仍然是外层安全边界。
  BAOYU_CHROME_PATH: '/usr/local/bin/baoyu-chromium',
  DEBIAN_FRONTEND: 'noninteractive',
};

/** 即使被允许清单或前缀命中，也绝不允许注入的精确键名——服务凭据。 */
const SHARED_ENV_DENYLIST = new Set([
  'SANDBOX_API_TOKEN',
  'SANDBOX_JWT_SECRET',
  'JWT_SECRET',
  'SANDBOX_DATABASE_URL',
  'DATABASE_URL',
  'MYSQL_ROOT_PASSWORD',
  'MYSQL_APP_PASSWORD',
  'MYSQL_MIGRATOR_PASSWORD',
  'POSTGRES_PASSWORD',
  'REDIS_CONTROL_PASSWORD',
  'REDIS_WORKER_PASSWORD',
  'WORKER_SERVICE_TOKEN',
  'AGENT_INTERNAL_TOKEN',
  'API_TOKEN',
]);

/** 命中任一子串即拒绝（大小写不敏感，比较前已转大写）。 */
const SHARED_ENV_DENY_SUBSTRINGS: readonly string[] = [
  'PASSWORD',
  'PRIVATE_KEY',
  'SECRET_KEY',
  '_SECRET',
  'SERVICE_TOKEN',
];

function isDeniedSharedKey(name: string): boolean {
  const upper = (name ?? '').trim().toUpperCase();
  if (!upper) return true;
  if (SHARED_ENV_DENYLIST.has(upper)) return true;
  if (upper.startsWith(EXEC_ENV_PREFIX) && isDeniedSharedKey(upper.slice(EXEC_ENV_PREFIX.length))) {
    return true;
  }
  return SHARED_ENV_DENY_SUBSTRINGS.some((token) => upper.includes(token));
}

function parseSharedEnvKeys(raw: string | readonly string[] | undefined): string[] {
  if (raw === undefined) return [];
  const items = Array.isArray(raw) ? raw : String(raw).trim().split(/[,;\s]+/);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const key = String(item ?? '').trim();
    if (!key || seen.has(key)) continue;
    if (!ENV_NAME_RE.test(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

export interface LoadSharedExecEnvOptions {
  /** 宿主进程环境；默认 `process.env`。测试用注入点。 */
  readonly processEnv?: Readonly<Record<string, string | undefined>>;
  /**
   * 显式允许清单（键名列表，或逗号/分号/空白分隔的字符串）。默认取
   * `processEnv.SANDBOX_SHARED_ENV_KEYS`。
   */
  readonly sharedKeys?: string | readonly string[];
}

/**
 * 构造"共享执行环境" map——对应 Python 版 `load_shared_exec_env()`。
 *
 * 来源（后者不覆盖前者，两者写进不相交的键空间靠调用方保证唯一性，
 * 与 Python 版一致——真正的"谁覆盖谁"发生在 {@link buildSafeEnvOverrides}
 * 的第三步）：
 * 1. `sharedKeys` 里点名、且在 `processEnv` 里存在的键；
 * 2. `processEnv` 里所有 `SANDBOX_EXEC_ENV_<NAME>` → 子进程里的 `<NAME>`。
 */
export function loadSharedExecEnv(options: LoadSharedExecEnvOptions = {}): Record<string, string> {
  const envMap = options.processEnv ?? process.env;
  const sharedKeys = options.sharedKeys ?? envMap['SANDBOX_SHARED_ENV_KEYS'];

  const result: Record<string, string> = {};

  for (const key of parseSharedEnvKeys(sharedKeys)) {
    if (isDeniedSharedKey(key)) continue;
    const value = envMap[key];
    if (value === undefined || value === null) continue;
    const text = String(value);
    if (text.includes('\x00')) continue;
    result[key] = text;
  }

  for (const [rawKey, value] of Object.entries(envMap)) {
    if (!rawKey.startsWith(EXEC_ENV_PREFIX)) continue;
    const childKey = rawKey.slice(EXEC_ENV_PREFIX.length);
    if (!childKey || !ENV_NAME_RE.test(childKey)) continue;
    if (isDeniedSharedKey(childKey) || isDeniedSharedKey(rawKey)) continue;
    if (value === undefined || value === null) continue;
    const text = String(value);
    if (text.includes('\x00')) continue;
    result[childKey] = text;
  }

  return result;
}

export interface BuildSafeEnvOverridesOptions {
  /** 每次调用方传入的覆盖值（`ShellExecRequest.env`），优先级最高。 */
  readonly overrides?: Readonly<Record<string, string>> | undefined;
  /** `false` 时跳过共享执行环境注入（默认 `true`）。 */
  readonly includeShared?: boolean | undefined;
  readonly processEnv?: Readonly<Record<string, string | undefined>> | undefined;
  readonly sharedKeys?: string | readonly string[] | undefined;
}

/**
 * 构造最终要交给 `buildIsolationProfile({ envOverrides })` 的环境变量表——
 * 对应 Python 版 `safe_env()`，但去掉了 `HOME`/`PWD` 的赋值（原因见文件头）。
 *
 * 合并顺序（后者覆盖前者）：基础默认值 → 共享执行环境 → 每次调用的
 * `overrides`（仍然按精确键名过一遍拒绝清单——`overrides` 不吃子串规则，
 * 因为那是给"合法但恰好名字里带 PASSWORD 的业务变量"留的口子，与 Python 版
 * `safe_env()` 对 `overrides` 只做精确名字匹配的行为一致）。
 */
export function buildSafeEnvOverrides(options: BuildSafeEnvOverridesOptions = {}): Record<string, string> {
  const env: Record<string, string> = { ...BASE_SAFE_ENV };

  if (options.includeShared ?? true) {
    const shared = loadSharedExecEnv({
      ...(options.processEnv !== undefined ? { processEnv: options.processEnv } : {}),
      ...(options.sharedKeys !== undefined ? { sharedKeys: options.sharedKeys } : {}),
    });
    Object.assign(env, shared);
  }

  if (options.overrides) {
    for (const [key, value] of Object.entries(options.overrides)) {
      if (!ENV_NAME_RE.test(key)) continue;
      if (value === undefined || value === null || String(value).includes('\x00')) continue;
      if (SHARED_ENV_DENYLIST.has(key.toUpperCase())) continue;
      env[key] = String(value);
    }
  }

  return env;
}
