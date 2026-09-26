/**
 * exec 侧的数据源目录（design `sandbox-data-sources.md` §3.1）。
 *
 * 目录解析与校验在 `@dsh/contract/data-sources.js`，Agent 与 exec 共用；本文件只多一条
 * exec 自己的启动约束：生产环境里 `SANDBOX_EXEC_ENV_*` 不能再携带看起来像口令的键
 * （`.env.example` 以前的示例是 `*_DB_PWD`，不含 safe-env 拦截的 `PASSWORD` 子串）。
 */

export {
  DataSourceConfigError,
  readDataSourceCatalog,
  type DataSourceConfig,
} from '@dsh/contract/data-sources.js';

const PLAINTEXT_DB_SECRET_RE = /PWD|PASSWD|PASSWORD/i;
/** 值里带 `scheme://user:password@` 的连接串（旧示例 `*_DSN`）。 */
const URL_CREDENTIALS_RE = /:\/\/[^/\s:@]+:[^@\s]+@/;

/**
 * 经 `SANDBOX_EXEC_ENV_*` 注入数据库口令的旧写法：键名像口令，或值是带口令的连接串。
 * 生产环境据此拒绝启动；开发环境只返回诊断，由调用方打印——本地示例库还在用旧写法时
 * 不至于起不来。只返回键名，不回显值。
 */
export function plaintextExecEnvSecrets(env: Readonly<Record<string, string | undefined>>): readonly string[] {
  return Object.keys(env)
    .filter((key) => key.startsWith('SANDBOX_EXEC_ENV_'))
    .filter((key) => PLAINTEXT_DB_SECRET_RE.test(key) || URL_CREDENTIALS_RE.test(env[key] ?? ''))
    .sort();
}
