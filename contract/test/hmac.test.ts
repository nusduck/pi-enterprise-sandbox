/**
 * `hmac.ts` 的测试：跨语言 golden fixture（防止 contract/ 这份 TS 实现与
 * 历史 Node/Python 实现的字节输出悄悄分叉），加上针对性的负面用例
 * （篡改请求体后签名校验必须失败）。
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  InternalHmacError,
  issueInternalToken,
  verifyInternalToken,
} from '../src/hmac.js';
import type { InternalHmacErrorCode } from '../src/hmac.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// contract/test → 仓库根是 ../../
const GOLDEN_FIXTURE_PATH = path.join(
  __dirname,
  '../../tests/fixtures/contracts/agent-sandbox-internal-hmac-hs256-v1.json',
);

interface GoldenFixture {
  readonly version: number;
  readonly contract: string;
  readonly key: { readonly kid: string; readonly keyBase64url: string };
  readonly now: number;
  readonly ttlSeconds: number;
  readonly randomBytesBase64url: string;
  readonly valid: ReadonlyArray<{
    readonly id: string;
    readonly issueClaims: unknown;
    readonly expectedClaims: Record<string, unknown>;
    readonly expectedToken: string;
    readonly request: {
      readonly method: string;
      readonly rawPath: string;
      readonly rawBodyUtf8: string;
    };
  }>;
  readonly invalid: ReadonlyArray<{
    readonly id: string;
    readonly kind: string;
    readonly token?: string;
    readonly tokenRef?: string;
    readonly rawBodyUtf8?: string;
    readonly nodeErrorCode?: string;
  }>;
}

const fixture = JSON.parse(readFileSync(GOLDEN_FIXTURE_PATH, 'utf8')) as GoldenFixture;

function expectCode(fn: () => unknown, code: InternalHmacErrorCode): void {
  assert.throws(
    fn,
    (error: unknown) => error instanceof InternalHmacError && error.code === code,
  );
}

describe('hmac: cross-language golden fixture', () => {
  it('loads shared golden fixture metadata', () => {
    assert.equal(fixture.version, 1);
    assert.equal(fixture.contract, 'agent-sandbox-internal-hmac-hs256-v1');
    assert.ok(fixture.valid.length >= 1);
    assert.ok(fixture.invalid.length >= 1);
  });

  for (const row of fixture.valid) {
    it(`issues and verifies exact golden token: ${row.id}`, () => {
      const keyring = Object.freeze({ [fixture.key.kid]: fixture.key.keyBase64url });
      const randomBytes = Buffer.from(fixture.randomBytesBase64url, 'base64url');
      assert.equal(randomBytes.length, 16);

      const token = issueInternalToken({
        keyring,
        activeKid: fixture.key.kid,
        claims: row.issueClaims,
        ttlSeconds: fixture.ttlSeconds,
        clock: () => fixture.now,
        randomBytes: (size) => {
          assert.equal(size, 16);
          return new Uint8Array(randomBytes);
        },
      });

      // 这是本模块存在的核心断言：字节级一致，逐字符相等，不是"语义等价"。
      assert.equal(token, row.expectedToken);

      const verified = verifyInternalToken(token, {
        keyring,
        clock: () => fixture.now,
      });
      assert.deepEqual(verified, row.expectedClaims);

      // 请求体摘要绑定：body_sha256 claim 必须等于原始请求体的 sha256。
      const bodyDigest = createHash('sha256')
        .update(row.request.rawBodyUtf8, 'utf8')
        .digest('hex');
      assert.equal(bodyDigest, row.expectedClaims.body_sha256);
      assert.equal(row.request.method, 'POST');
      assert.equal(row.request.rawPath, row.expectedClaims.htu);
    });
  }

  for (const row of fixture.invalid) {
    if (row.kind === 'signature') {
      it(`rejects golden negative vector: ${row.id}`, () => {
        const keyring = Object.freeze({ [fixture.key.kid]: fixture.key.keyBase64url });
        assert.ok(row.token);
        assert.ok(row.nodeErrorCode);
        expectCode(
          () => verifyInternalToken(row.token, { keyring, clock: () => fixture.now }),
          row.nodeErrorCode as InternalHmacErrorCode,
        );
      });
    } else if (row.kind === 'body') {
      it(`detects golden body-tampering vector: ${row.id}`, () => {
        const positive = fixture.valid.find((v) => v.id === row.tokenRef);
        assert.ok(positive, `missing tokenRef ${row.tokenRef}`);
        assert.ok(row.rawBodyUtf8 !== undefined);

        // 篡改后的请求体摘要必须和 token 里签的 body_sha256 对不上——
        // 这一步（body binding）发生在 HTTP 适配层，不在这个纯令牌模块
        // 里，所以这里直接验证摘要不相等，而不是调用一个不存在的
        // request-binding 函数。
        const tamperedDigest = createHash('sha256')
          .update(row.rawBodyUtf8, 'utf8')
          .digest('hex');
        assert.notEqual(tamperedDigest, positive!.expectedClaims.body_sha256);

        // 令牌本身依然有效——只是不再绑定到这份被篡改的请求体。
        const keyring = Object.freeze({ [fixture.key.kid]: fixture.key.keyBase64url });
        assert.doesNotThrow(() =>
          verifyInternalToken(positive!.expectedToken, { keyring, clock: () => fixture.now }),
        );
      });
    }
  }
});

describe('hmac: tampering', () => {
  const KEY_BYTES = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
  const KEY = KEY_BYTES.toString('base64url');
  const KEYRING = Object.freeze({ '2026-07': KEY });
  const NOW = 1_700_000_000;
  const RANDOM_128 = Uint8Array.from(Array.from({ length: 16 }, (_, index) => index));

  const ISSUE_CLAIMS = Object.freeze({
    org_id: '01K0G2PAV8FPMVC9QHJG7JPN4Z',
    user_id: '01K0G2PAV8FPMVC9QHJG7JPN50',
    conversation_id: '01K0G2PAV8FPMVC9QHJG7JPN51',
    agent_session_id: '01K0G2PAV8FPMVC9QHJG7JPN52',
    sandbox_session_id: '01K0G2PAV8FPMVC9QHJG7JPN5F',
    run_id: '01K0G2PAV8FPMVC9QHJG7JPN5H',
    tool_execution_id: '01K0G2PAV8FPMVC9QHJG7JPN5K',
    tool_call_id: 'tool-call-7',
    tool_name: 'sandbox_bash',
    scope: Object.freeze(['execute:command']),
    request_hash: 'a'.repeat(64),
    execution_fence_token: 7,
    trace_id: 'b'.repeat(32),
    htm: 'POST' as const,
    htu: '/internal/v1/executions/bash',
    body_sha256: 'c'.repeat(64),
  });

  function issue(): string {
    return issueInternalToken({
      keyring: KEYRING,
      activeKid: '2026-07',
      claims: ISSUE_CLAIMS,
      clock: () => NOW,
      randomBytes: () => RANDOM_128,
    });
  }

  it('rejects a token whose body_sha256 claim was rewritten after signing', () => {
    const token = issue();
    const [header, payload, signature] = token.split('.');
    const claims = JSON.parse(Buffer.from(payload as string, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    // 篡改请求体摘要（模拟"攻击者改了请求体但复用旧签名"）。
    claims.body_sha256 = 'd'.repeat(64);
    const tamperedPayload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const tamperedToken = `${header}.${tamperedPayload}.${signature}`;

    expectCode(
      () => verifyInternalToken(tamperedToken, { keyring: KEYRING, clock: () => NOW }),
      'INTERNAL_TOKEN_SIGNATURE_INVALID',
    );
  });

  it('rejects a token whose signature was flipped', () => {
    const token = issue();
    const [header, payload, signature] = token.split('.');
    const flipped = (signature as string).slice(0, -1) + ((signature as string).endsWith('A') ? 'B' : 'A');
    expectCode(
      () => verifyInternalToken(`${header}.${payload}.${flipped}`, { keyring: KEYRING, clock: () => NOW }),
      'INTERNAL_TOKEN_SIGNATURE_INVALID',
    );
  });

  it('round-trips cleanly when nothing is tampered with', () => {
    const token = issue();
    assert.doesNotThrow(() => verifyInternalToken(token, { keyring: KEYRING, clock: () => NOW }));
  });
});
