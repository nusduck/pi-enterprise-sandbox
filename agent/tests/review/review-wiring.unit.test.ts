/**
 * 审核面的装配（`bootstrap/review-wiring.ts`）。
 *
 * 这一条是**真机重建时踩出来的**：compose 里的 sandbox 是内网明文 HTTP
 * （`http://sandbox:8081`），不是字面 loopback。`normalizeBaseUrl` 默认只放行
 * loopback 的明文 http，漏传 `allowInsecureHttp` 会在**启动期**抛错，让整个 agent
 * HTTP 进程起不来——而单测不会发现，因为测试用的 baseUrl 往往是 `http://exec`。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createReviewTransportFromEnv } from '../../src/bootstrap/review-wiring.js';

const KEYRING = JSON.stringify({ kid1: Buffer.from('0'.repeat(32), 'utf8').toString('base64url') });

function env(overrides: Record<string, string> = {}) {
  return {
    SANDBOX_BASE_URL: 'http://sandbox:8081',
    SANDBOX_INTERNAL_HMAC_KEYRING: KEYRING,
    SANDBOX_INTERNAL_HMAC_ACTIVE_KID: 'kid1',
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe('审核面 exec 客户端装配', () => {
  it('内网明文 HTTP 的 sandbox 地址可用（与另两个 exec 传输同一口径）', () => {
    const transport = createReviewTransportFromEnv(env());
    assert.ok(transport, 'keyring 齐备时必须装配出客户端');
  });

  it('缺密钥环 → null（fail-closed，不是降级放行）', () => {
    assert.equal(createReviewTransportFromEnv(env({ SANDBOX_INTERNAL_HMAC_KEYRING: '' })), null);
    assert.equal(createReviewTransportFromEnv(env({ SANDBOX_INTERNAL_HMAC_ACTIVE_KID: '' })), null);
  });

  it('HTTPS 地址照常可用（不受 allowInsecureHttp 影响）', () => {
    assert.ok(createReviewTransportFromEnv(env({ SANDBOX_BASE_URL: 'https://sandbox.internal' })));
  });
});
