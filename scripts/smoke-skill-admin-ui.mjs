#!/usr/bin/env node
/** Browser regression against frontend/dist. API fixtures never reach a live backend. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { before, after, test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const ids = Array.from({ length: 1001 }, (_, i) => String(i).padStart(26, '0'));
let preview;
let browser;
let baseUrl;

before(async () => {
  baseUrl = process.env.SKILL_ADMIN_UI_BASE_URL;
  if (!baseUrl) {
    const socket = createServer();
    await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
    const port = socket.address().port;
    await new Promise((resolve) => socket.close(resolve));
    baseUrl = `http://127.0.0.1:${port}`;
    preview = spawn(process.execPath, [
      `${root}frontend/node_modules/vite/bin/vite.js`, 'preview', '--host', '127.0.0.1',
      '--port', String(port), '--strictPort',
    ], { cwd: `${root}frontend`, stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Preview startup timed out')), 15_000);
      preview.on('error', (err) => { clearTimeout(timer); reject(err); });
      preview.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Preview exited: ${code}`)); });
      preview.stdout.on('data', (chunk) => {
        if (String(chunk).includes('Local:')) { clearTimeout(timer); resolve(); }
      });
    });
  }
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}),
  });
});

after(async () => {
  await browser?.close();
  preview?.kill('SIGTERM');
});

async function fixture(revoke) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    let status = 200;
    let body = {};
    if (pathname === '/api/auth/me') body = { username: 'ui-fixture', role: 'admin' };
    else if (pathname === '/api/admin/skills/org') body = { skills: [{
      name: 'fixture-skill', currentDigest: 'a'.repeat(64),
      versions: [{ contentDigest: 'a'.repeat(64), status: 'active' }],
    }] };
    else if (pathname.endsWith('/revoke')) ({ status, body } = await revoke());
    else if (pathname.endsWith('/manifest')) body = {
      name: 'fixture-skill', contentDigest: 'a'.repeat(64), fileCount: 1, totalBytes: 4,
      files: [{ path: 'SKILL.md', bytes: 4 }], skillMd: 'test', truncated: true,
      affectedAgentVersionIds: ids,
    };
    else if (pathname.includes('share-requests')) body = { requests: [] };
    else if (pathname === '/api/conversations') body = [];
    else if (pathname === '/api/agents') body = { agents: [] };
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto(`${baseUrl}/admin/skills`);
  await page.getByRole('tab', { name: '组织共享层' }).click();
  return page;
}

test('busy revoke ignores Escape; failure retains reason and permits retry', async () => {
  let release;
  let started;
  const requestStarted = new Promise((resolve) => { started = resolve; });
  let attempts = 0;
  const page = await fixture(async () => {
    if (++attempts > 1) return { status: 200, body: { affectedAgentVersionIds: ids } };
    started();
    await new Promise((resolve) => { release = resolve; });
    return { status: 503, body: { error: 'fixture failure' } };
  });
  try {
    await page.getByRole('button', { name: '吊销', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '吊销组织共享 Skill 版本', exact: true });
    await dialog.locator('textarea').fill('retained reason');
    await dialog.getByRole('button', { name: '确认吊销', exact: true }).click();
    await requestStarted;
    assert.equal(await dialog.getByRole('button', { name: '取消', exact: true }).isDisabled(), true);
    await page.keyboard.press('Escape');
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await dialog.isVisible(), true, 'Escape must not unmount the in-flight dialog');
    release();
    await dialog.getByRole('alert').waitFor();
    assert.match(await dialog.getByRole('alert').innerText(), /fixture failure/);
    assert.equal(await dialog.locator('textarea').inputValue(), 'retained reason');
    await dialog.getByRole('button', { name: '确认吊销', exact: true }).click();
    await page.getByRole('dialog', { name: '吊销成功', exact: true }).waitFor();
    assert.equal(attempts, 2);
  } finally { release?.(); await page.close(); }
});

test('idle dialog allows Escape and prevents keyboard access to background controls', async () => {
  const page = await fixture(async () => ({ status: 200, body: { affectedAgentVersionIds: ids } }));
  try {
    await page.getByRole('button', { name: '吊销', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('textarea').fill('reason');
    await dialog.getByRole('button', { name: '确认吊销', exact: true }).focus();
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement === document.body
        || Boolean(document.activeElement.closest('dialog'))), true);
    }
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
  } finally { await page.close(); }
});

test('complete 1001-reference results and manifests do not claim truncation', async () => {
  const page = await fixture(async () => ({ status: 200, body: { affectedAgentVersionIds: ids } }));
  try {
    await page.getByRole('button', { name: '吊销', exact: true }).click();
    await page.getByRole('dialog').locator('textarea').fill('reason');
    await page.getByRole('button', { name: '确认吊销', exact: true }).click();
    const result = page.getByRole('dialog', { name: '吊销成功', exact: true });
    await result.waitFor();
    assert.equal(await result.getByText('已截断', { exact: true }).count(), 0);
    assert.equal(await result.getByRole('button', { name: '复制全部 (1001)', exact: true }).count(), 1);
    await result.getByRole('button', { name: '下一页', exact: true }).click();
    assert.equal(await result.getByText('第 2 / 101 页', { exact: true }).count(), 1);
    await result.locator('input[type=search]').fill(ids[1000]);
    assert.equal(await result.getByText(ids[1000], { exact: true }).count(), 1);
    await result.getByRole('button', { name: '完成', exact: true }).click();
    await page.getByRole('button', { name: '清单', exact: true }).click();
    const manifest = page.getByRole('dialog', { name: '版本清单', exact: true });
    await manifest.waitFor();
    assert.equal(await manifest.getByText('已截断', { exact: true }).count(), 0);
    assert.equal(await manifest.getByText('SKILL.md（已截断）', { exact: true }).count(), 1);
    await manifest.locator('input[type=search]').fill(ids[1000]);
    assert.equal(await manifest.getByText(ids[1000], { exact: true }).count(), 1);
  } finally { await page.close(); }
});
