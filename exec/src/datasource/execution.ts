/**
 * 内部 shell 路由与数据源服务之间的薄胶水：打开会话、结果脱敏、后台输出的流式脱敏。
 * 单独成文件，是为了让 `internal-shell.ts` 只多几行接线，而不是长出第二套生命周期。
 */

import { ContractError } from '@dsh/contract/errors.js';
import type { DataSourceMount } from '../types.js';
import type { ExecutionAudit } from './forwarder.js';
import { redactSecrets, StreamSecretRedactor } from './redact.js';
import type { DataSourceService, DataSourceSession } from './service.js';

const NO_SOURCES: DataSourceSession = Object.freeze({
  mounts: Object.freeze([]) as readonly DataSourceMount[],
  close: async () => undefined,
});

/**
 * 清单为空 → 不打开任何东西。清单非空但本进程没配数据源 → `DATA_SOURCE_UNKNOWN`：
 * Agent 与 exec 的配置漂移要当场报出来，而不是让命令在没有库的沙箱里跑。
 */
export async function openExecutionDataSources(
  service: DataSourceService | undefined,
  ids: readonly string[],
  audit: ExecutionAudit,
): Promise<DataSourceSession> {
  if (ids.length === 0) return NO_SOURCES;
  if (service === undefined) {
    throw new ContractError('DATA_SOURCE_UNKNOWN', `data source is not configured: ${ids[0]}`);
  }
  return service.open(ids, audit);
}

function secretsOf(mounts: readonly DataSourceMount[]): string[] {
  return mounts.map((m) => m.secret);
}

interface TextLike {
  readonly text: string;
  readonly truncated: boolean;
}

/** 前台结果：stdout/stderr 全文替换。没有数据源时原样返回。 */
export function redactRunResult<T extends { stdout: TextLike; stderr: TextLike }>(
  result: T,
  mounts: readonly DataSourceMount[],
): T {
  if (mounts.length === 0) return result;
  const secrets = secretsOf(mounts);
  return {
    ...result,
    stdout: { ...result.stdout, text: redactSecrets(result.stdout.text, secrets) },
    stderr: { ...result.stderr, text: redactSecrets(result.stderr.text, secrets) },
  };
}

/**
 * 后台作业的增量读取包一层流式脱敏。`end()` 在作业结束时调用：之后的读取把暂扣的
 * 尾部一并放出（作业账本在进程结束后还会最后读一次）。
 */
export function redactingReader<C extends { delta: string }>(
  read: () => C,
  mounts: readonly DataSourceMount[],
): { read: () => C; end: () => void } {
  if (mounts.length === 0) return { read, end: () => undefined };
  const redactor = new StreamSecretRedactor(secretsOf(mounts));
  let ended = false;
  return {
    read: () => {
      const chunk = read();
      return { ...chunk, delta: redactor.push(chunk.delta, ended) };
    },
    end: () => {
      ended = true;
    },
  };
}
