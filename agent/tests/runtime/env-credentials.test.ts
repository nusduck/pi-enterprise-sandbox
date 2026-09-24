/**
 * 只读 env 凭据——缺配 fail-closed，set/unset 拒绝写入。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { EnvCredentialsProvider } from '../../src/runtime/providers/env-credentials.js';
import { assertBootReady } from '../../src/runtime/boot.js';

test('resolve：缺配或空串返回 undefined（fail-closed）', async () => {
  const prev = process.env['LLMIO_API_KEY'];
  delete process.env['LLMIO_API_KEY'];
  const ctx = new Context();
  const creds = new EnvCredentialsProvider(ctx);
  try {
    assert.equal(await creds.resolve('LLMIO_API_KEY' as never), undefined);
    process.env['LLMIO_API_KEY'] = '   ';
    assert.equal(await creds.resolve('LLMIO_API_KEY' as never), undefined);
  } finally {
    if (prev === undefined) delete process.env['LLMIO_API_KEY'];
    else process.env['LLMIO_API_KEY'] = prev;
  }
});

test('resolve：环境变量有值则只读返回，不落盘', async () => {
  const prev = process.env['LLMIO_API_KEY'];
  process.env['LLMIO_API_KEY'] = 'sk-test';
  const ctx = new Context();
  const creds = new EnvCredentialsProvider(ctx);
  try {
    const hit = await creds.resolve('LLMIO_API_KEY' as never);
    assert.equal(hit?.value, 'sk-test');
    assert.equal(hit?.source, 'env');
    const info = await creds.describe('LLMIO_API_KEY' as never);
    assert.equal(info.configured, true);
    assert.equal(info.writable, false);
  } finally {
    if (prev === undefined) delete process.env['LLMIO_API_KEY'];
    else process.env['LLMIO_API_KEY'] = prev;
  }
});

test('set/unset/modifyRecord 拒绝写入', async () => {
  const ctx = new Context();
  const creds = new EnvCredentialsProvider(ctx);
  await assert.rejects(() => creds.set('LLMIO_API_KEY' as never, 'x'), /read-only/);
  await assert.rejects(() => creds.unset('LLMIO_API_KEY' as never), /read-only/);
  await assert.rejects(
    () => creds.modifyRecord('llm-deepseek/x' as never, async () => undefined),
    /not supported/,
  );
});

test('assertBootReady：缺 LLMIO_API_KEY 关闭能力', async () => {
  const prev = process.env['LLMIO_API_KEY'];
  delete process.env['LLMIO_API_KEY'];
  const ctx = {
    get: () => new EnvCredentialsProvider(new Context()),
  };
  try {
    await assert.rejects(() => assertBootReady(ctx as never), /LLMIO_API_KEY not configured/);
  } finally {
    if (prev === undefined) delete process.env['LLMIO_API_KEY'];
    else process.env['LLMIO_API_KEY'] = prev;
  }
});

test('assertBootReady：非法 LLMIO_BASE_URL 关闭能力', async () => {
  const prevKey = process.env['LLMIO_API_KEY'];
  const prevUrl = process.env['LLMIO_BASE_URL'];
  process.env['LLMIO_API_KEY'] = 'sk-test';
  process.env['LLMIO_BASE_URL'] = 'not-a-url';
  const ctx = {
    get: () => new EnvCredentialsProvider(new Context()),
  };
  try {
    await assert.rejects(() => assertBootReady(ctx as never), /not a valid URL/);
  } finally {
    if (prevKey === undefined) delete process.env['LLMIO_API_KEY'];
    else process.env['LLMIO_API_KEY'] = prevKey;
    if (prevUrl === undefined) delete process.env['LLMIO_BASE_URL'];
    else process.env['LLMIO_BASE_URL'] = prevUrl;
  }
});
