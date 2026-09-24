/**
 * 只读环境变量凭据提供方——取代 `dsh-credentials-local`。
 *
 * 这是什么：`ctx.credentials` 的最小实现，只从服务端环境变量解析，
 * 不落盘、不热重载、不进模型上下文。`dsh-llm-deepseek` 强依赖
 * `ctx.credentials` 才能取到 `apiKeyEnv`，而 `dsh-credentials-local`
 * 没有租户维度且带热重载设置文件，在多租户下是配置漂移面，
 * 因此必须自写这一层（dsh-rebuild 4.5 的洞，现补进 4.2 自建清单）。
 *
 * 为什么只读环境变量：密钥由部署层注入（K8s Secret / env），
 * 不允许在运行时通过 `set` 写入文件；写入会静默被进程环境遮蔽，
 * 造成“看似成功、实则不生效”的假象，所以 `set`/`unset` 直接失败。
 * 记录半区（`CredentialKey` 的 grant / api-key）本服务不支持——
 * 当前栈只用 `CredentialRef` 的 `LLMIO_API_KEY`，如将来需要 grant
 * 再单独接一个可写 provider，当前拒绝是 fail-closed。
 */

import { CredentialProvider } from '@deepseek-ai/dsh-credentials';
import type {
  CredentialInfo,
  CredentialKey,
  CredentialRecord,
  CredentialRecordEntry,
  CredentialRecordInfo,
  CredentialRef,
  ResolvedCredential,
} from '@deepseek-ai/dsh-credentials';
import type { Context } from '@deepseek-ai/cordis';

/**
 * 从环境变量只读解析的凭据服务。
 */
export class EnvCredentialsProvider extends CredentialProvider {
  constructor(ctx: Context) {
    super(ctx);
  }

  async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const raw = (process.env as Record<string, string | undefined>)[ref as string];
    if (raw === undefined || raw.trim() === '') return undefined;
    return { value: raw, source: 'env' };
  }

  async describe(ref: CredentialRef): Promise<CredentialInfo> {
    const raw = (process.env as Record<string, string | undefined>)[ref as string];
    const configured = raw !== undefined && raw.trim() !== '';
    if (configured) {
      return {
        configured: true,
        source: 'env',
        writable: false,
      };
    }
    return {
      configured: false,
      writable: false,
    };
  }

  async set(_ref: CredentialRef, _value: string): Promise<void> {
    throw new Error(
      'credentials: env-only provider is read-only — set LLMIO_API_KEY in the launching environment, not via ctx.credentials.set',
    );
  }

  async unset(_ref: CredentialRef): Promise<void> {
    throw new Error(
      'credentials: env-only provider is read-only — unset LLMIO_API_KEY in the launching environment',
    );
  }

  async readRecord(_key: CredentialKey): Promise<CredentialRecord | undefined> {
    return undefined;
  }

  async describeRecord(_key: CredentialKey): Promise<CredentialRecordInfo> {
    return { configured: false, writable: false };
  }

  async listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return [];
  }

  async modifyRecord(
    _key: CredentialKey,
    _mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    throw new Error('credentials: record writes not supported in env-only provider');
  }

  async deleteRecord(_key: CredentialKey): Promise<void> {
    // record 半区无存储，删除是 no-op
  }
}

export default EnvCredentialsProvider;
