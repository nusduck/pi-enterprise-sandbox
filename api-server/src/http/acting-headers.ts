/**
 * `X-Acting-*` 头的单一来源（C5 A2）。
 *
 * 安全不变量（AGENTS.md §2）：`X-Acting-*` 必须由服务端解析后写入，永远不能
 * 透传浏览器的。`services/sandbox-client.ts` 与 `routes/files.ts` 各手写一份
 * 剥离名单，且只认识两种大小写——全大写/混合大小写的变体能漏过去。大小写
 * 不敏感地剥离才是完整的（Node 对入站 wire 头会小写化，但这里剥的是代码里
 * 拼出来的 `extra` 对象，什么大小写都可能出现）。
 */

import type { SandboxAuthContext } from '../services/sandbox-client.js';

/** 规范拼写（外发时只写这三个）。 */
export const ACTING_HEADER_NAMES = [
  'X-Acting-User-Id',
  'X-Acting-Organization-Id',
  'X-Acting-Role',
] as const;

const ACTING_HEADER_LOWER = new Set(
  ACTING_HEADER_NAMES.map((name) => name.toLowerCase()),
);

export function isActingHeaderName(name: unknown): boolean {
  return typeof name === 'string' && ACTING_HEADER_LOWER.has(name.toLowerCase());
}

/**
 * 去掉 `extra` 里的一切 `X-Acting-*`（大小写不敏感），返回一个新对象，
 * 不改动入参。调用方随后只写服务端解析出的身份。
 */
export function stripActingHeaders<T extends Record<string, unknown>>(
  extra: T,
): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extra)) {
    if (!isActingHeaderName(key)) out[key] = value;
  }
  return out as T;
}

/**
 * 把服务端已解析的身份写进外发头。两个调用点共用这一份写入形状：
 * 只有 `actingUserId + actingOrganizationId` 齐了才写（sandbox-client 的
 * `headers()` 原语义）；缺了是抛错还是跳过由调用方决定——`files.ts` 的
 * `sandboxProxyHeaders` 保持 fail-closed 抛错。
 */
export function applyTrustedActingHeaders(
  headers: Record<string, string>,
  auth: Pick<
    SandboxAuthContext,
    'actingUserId' | 'actingOrganizationId' | 'actingRole'
  > | null | undefined,
): void {
  if (auth?.actingUserId && auth?.actingOrganizationId) {
    headers['X-Acting-User-Id'] = auth.actingUserId;
    headers['X-Acting-Organization-Id'] = auth.actingOrganizationId;
    if (auth.actingRole) headers['X-Acting-Role'] = auth.actingRole;
  }
}
