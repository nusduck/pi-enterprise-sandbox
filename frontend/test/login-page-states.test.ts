import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  noLoginMethodMessage,
  projectLoginCapabilities,
  type LoginCapabilities,
} from '../src/shared/schemas/auth.ts';

const here = dirname(fileURLToPath(import.meta.url));
const readSrc = (...parts: string[]) => readFileSync(join(here, '..', 'src', ...parts), 'utf8');

describe('LoginPage 状态展示（加载态、全局认证错误、无可用方式）', () => {
  it('noLoginMethodMessage 在无可用登录方式时给出对应文案，有方式时返回 null', () => {
    // 1. 无可用登录方式（SSO 开启但不可用，本地未开启）
    const noMethodCaps: LoginCapabilities = {
      mode: 'sso',
      localEnabled: false,
      registrationEnabled: false,
      ssoAvailable: false,
      ssoEnabled: true,
      localAdminOnly: false,
      ssoLabel: '公司 SSO',
      defaultEditableFields: [],
      modeDiagnosed: false,
    };
    assert.equal(noLoginMethodMessage(noMethodCaps), '当前部署未开放任何登录方式，请联系管理员。');

    // 2. 未知模式且无可用方式
    const unknownModeCaps: LoginCapabilities = {
      ...noMethodCaps,
      mode: 'custom_oauth',
      modeDiagnosed: true,
    };
    assert.match(noLoginMethodMessage(unknownModeCaps)!, /服务端返回了未知登录模式「custom_oauth」/);

    // 3. 有可用方式（local 或 ssoAvailable）时返回 null
    const localCaps: LoginCapabilities = { ...noMethodCaps, localEnabled: true };
    assert.equal(noLoginMethodMessage(localCaps), null);

    const ssoCaps: LoginCapabilities = { ...noMethodCaps, ssoAvailable: true };
    assert.equal(noLoginMethodMessage(ssoCaps), null);
  });

  it('LoginPage.tsx 源码中完整覆盖 loading 提示、authError 重试与 noLoginMethod 报警', () => {
    const tsx = readSrc('pages', 'login', 'LoginPage.tsx');

    // 1. 加载中状态展示「正在加载登录方式…」
    assert.match(tsx, /authConfig\.loading\s*\?\s*\(\s*<div\s+role="status"\s+className=\{s\.loadingState\}>\s*正在加载登录方式…\s*<\/div>\s*\)\s*:\s*null/);

    // 2. 全局认证错误展示 state.authError 并提供 retryAuth 重试按钮
    assert.match(tsx, /state\.authError\s*\?/);
    assert.match(tsx, /<span>\{state\.authError\}<\/span>/);
    assert.match(tsx, /onClick=\{\(\)\s*=>\s*void\s+retryAuth\(\)\}/);

    // 3. 无可用登录方式时显示 warningAlert 与 noLoginMethodMessage
    assert.match(tsx, /!authConfig\.loading\s*&&\s*caps\s*&&\s*noLoginMethodMessage\(caps\)/);
    assert.match(tsx, /\{noLoginMethodMessage\(caps\)\}/);

    // 4. 处于 loading 或无可用登录方式时，不渲染登录方式表单（fail-closed）
    assert.match(tsx, /!authConfig\.loading\s*&&\s*caps\s*&&\s*!noLoginMethodMessage\(caps\)\s*&&\s*caps\.ssoEnabled/);
    assert.match(tsx, /!authConfig\.loading\s*&&\s*caps\s*&&\s*!noLoginMethodMessage\(caps\)\s*&&\s*caps\.localEnabled/);

    // 5. SSO 按钮文案：中英文之间恰好一个空格（逐字断言见 ui-polish-followups.test.ts 的 ssoButtonText）
    assert.match(tsx, /\{ssoButtonText\(caps\.ssoLabel\)\}/);
  });
});

describe('loginErrorMessage 错误码与英文原文中文映射', () => {
  it('把 401、INVALID_CREDENTIALS 及 Invalid credentials 映射成中文「用户名或密码错误」', async () => {
    const { loginErrorMessage } = await import('../src/pages/login/loginError.ts');

    assert.equal(loginErrorMessage({ code: 'INVALID_CREDENTIALS', message: 'Invalid credentials' }, '登录失败'), '用户名或密码错误');
    assert.equal(loginErrorMessage({ status: 401, message: 'Invalid credentials' }, '登录失败'), '用户名或密码错误');
    assert.equal(loginErrorMessage(new Error('Invalid credentials: bad password'), '登录失败'), '用户名或密码错误');
    assert.equal(loginErrorMessage({ status: 401 }, '登录失败'), '用户名或密码错误');
  });

  it('保留 LOCAL_LOGIN_RESTRICTED 及注册相关错误码的中文提示', async () => {
    const { loginErrorMessage } = await import('../src/pages/login/loginError.ts');

    assert.match(loginErrorMessage({ code: 'LOCAL_LOGIN_RESTRICTED' }, 'x'), /公司 SSO/);
    assert.match(loginErrorMessage({ code: 'USERNAME_EXISTS' }, 'x'), /用户名已存在/);
    assert.match(loginErrorMessage({ code: 'REGISTRATION_DISABLED' }, 'x'), /未开放自主注册/);
    assert.match(loginErrorMessage({ code: 'AUTH_STORE_UNAVAILABLE' }, 'x'), /登录服务暂时不可用/);
  });

  it('保留已有中文错误信息，对未知英文错误用 fallback 中文兜底', async () => {
    const { loginErrorMessage } = await import('../src/pages/login/loginError.ts');

    // 已有中文错误
    assert.equal(loginErrorMessage(new Error('网络连接超时，请重试'), '默认兜底'), '网络连接超时，请重试');
    // 未知英文错误不向用户泄漏
    assert.equal(loginErrorMessage(new Error('Internal Server Error 500'), '登录失败，请稍后重试'), '登录失败，请稍后重试');
    assert.equal(loginErrorMessage({ code: 'UNKNOWN_CODE', message: 'something bad' }, '用户名或密码错误'), '用户名或密码错误');
  });
});

