/**
 * 交付策略解析（design `agent-output-review.md` §2，ADR 0016 D3）。
 *
 * 断言的是**默认值与 fail-closed 方向**：省略即 direct（既有版本不受影响），
 * 非法取值绝不回落成 direct，会话确保字段只在 review 时出现。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DELIVERY_POLICY,
  DeliveryPolicyError,
  normalizedDeliveryPolicy,
  parseDeliveryPolicy,
  parseSessionDelivery,
  sessionDeliveryField,
} from '../src/delivery-policy.js';

test('omitted deliveryPolicy means direct', () => {
  for (const raw of [undefined, null, {}]) {
    const parsed = parseDeliveryPolicy(raw);
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.policy?.mode, 'direct');
  }
  assert.equal(DEFAULT_DELIVERY_POLICY.mode, 'direct');
});

test('review is parsed case-insensitively and trimmed', () => {
  assert.equal(parseDeliveryPolicy({ mode: 'review' }).policy?.mode, 'review');
  assert.equal(parseDeliveryPolicy({ mode: ' REVIEW ' }).policy?.mode, 'review');
  assert.equal(parseDeliveryPolicy({ mode: 'Direct' }).policy?.mode, 'direct');
});

test('unknown mode fails closed instead of falling back to direct', () => {
  for (const mode of ['audit', 'REVIEWED', true, 1, []]) {
    const parsed = parseDeliveryPolicy({ mode });
    assert.equal(parsed.policy, null, `mode=${JSON.stringify(mode)} must not resolve`);
    assert.ok(parsed.errors.length > 0);
  }
});

test('unknown fields and wrong shapes are diagnosed', () => {
  assert.equal(parseDeliveryPolicy('review').policy, null);
  assert.equal(parseDeliveryPolicy({ mode: 'review', reviewers: ['u1'] }).policy, null);
  assert.equal(
    parseDeliveryPolicy({ mode: 'review', reviewers: [] }).errors[0]?.code,
    'CONFIG_UNKNOWN_FIELD',
  );
});

test('normalized config omits the default but keeps review', () => {
  assert.equal(normalizedDeliveryPolicy({ mode: 'direct' }), undefined);
  assert.deepEqual(normalizedDeliveryPolicy({ mode: 'review' }), { mode: 'review' });
});

test('session ensure carries review only, and direct is not a revocation', () => {
  assert.equal(sessionDeliveryField('review'), 'review');
  assert.equal(sessionDeliveryField('direct'), null);
  assert.equal(parseSessionDelivery(undefined), null);
  assert.equal(parseSessionDelivery('review'), 'review');
  // `direct` 是旧版 Agent 的等价形状：不带策略，不是"改回直接交付"。
  assert.equal(parseSessionDelivery('direct'), null);
  assert.throws(() => parseSessionDelivery('audit'), DeliveryPolicyError);
  assert.throws(() => parseSessionDelivery(42), DeliveryPolicyError);
});

test('REVIEW_TRANSFER_MAX_BYTES：100 MiB，且 base64 后仍在 V8 单字符串上限之内', async () => {
  const { REVIEW_TRANSFER_MAX_BYTES } = await import('../src/delivery-policy.js');
  assert.equal(REVIEW_TRANSFER_MAX_BYTES, 100 * 1024 * 1024);
  // 内部面是 JSON + base64；Node 22 单个字符串上限约 2^29-24 个字符，
  // 超过 ~384 MiB 的文件编码时抛 ERR_STRING_TOO_LONG（2026-10-01 实测 390 MiB 失败）。
  assert.ok(Math.ceil(REVIEW_TRANSFER_MAX_BYTES / 3) * 4 < 2 ** 29 - 24);
});
