/**
 * 公司 SSO 浏览器侧：入口地址、回调错误码的展示与清理、SSO 模式下的登录能力。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AuthConfigSchema, projectLoginCapabilities } from '../src/shared/schemas/auth.ts';
import {
  localLoginErrorMessage,
  ssoErrorMessage,
  ssoLoginUrl,
  takeSsoError,
} from '../src/shared/api/sso.ts';

function fakeHistory() {
  const calls: string[] = [];
  return {
    calls,
    state: { key: 'k' },
    replaceState(_state: unknown, _title: string, url: string) {
      calls.push(url);
    },
  };
}

describe('SSO entry', () => {
  it('sends the current in-site path as return_to', () => {
    assert.equal(ssoLoginUrl('/c/123?tab=a'), '/api/auth/sso/login?return_to=%2Fc%2F123%3Ftab%3Da');
    assert.equal(ssoLoginUrl('//evil.example'), '/api/auth/sso/login?return_to=%2F');
  });
});

describe('SSO callback errors', () => {
  it('maps the stable code to a message and strips only sso_error from the address bar', () => {
    const history = fakeHistory();
    const message = takeSsoError({ pathname: '/', search: '?sso_error=SSO_ACCESS_DENIED&keep=1', hash: '#h' }, history);
    assert.equal(message, ssoErrorMessage('SSO_ACCESS_DENIED'));
    assert.deepEqual(history.calls, ['/?keep=1#h']);
  });

  it('never echoes text from the URL: unknown codes get a fixed fallback', () => {
    const history = fakeHistory();
    const message = takeSsoError({ pathname: '/', search: '?sso_error=%3Cscript%3E', hash: '' }, history);
    assert.equal(message, '公司 SSO 登录失败，请重试。');
    assert.equal(message?.includes('<script>'), false);
  });

  it('does nothing when there is no sso_error', () => {
    const history = fakeHistory();
    assert.equal(takeSsoError({ pathname: '/c/1', search: '?x=1', hash: '' }, history), null);
    assert.deepEqual(history.calls, []);
  });

  it('tells employees to use SSO when local login is restricted to admins', () => {
    assert.match(localLoginErrorMessage({ code: 'LOCAL_LOGIN_RESTRICTED', message: 'Use company SSO' }, 'x'), /公司 SSO/);
    assert.equal(localLoginErrorMessage({ code: 'INVALID_CREDENTIALS', message: 'Invalid credentials' }, 'x'), 'Invalid credentials');
    assert.equal(localLoginErrorMessage({}, '登录失败'), '登录失败');
  });
});

describe('login capabilities in SSO mode', () => {
  const ssoDto = {
    mode: 'sso',
    methods: {
      local: { enabled: true, registration_enabled: false },
      sso: { enabled: true, available: true, label: '公司 SSO' },
    },
  };

  it('offers SSO and keeps local login as the admin-only fallback', () => {
    const caps = projectLoginCapabilities(AuthConfigSchema.parse(ssoDto));
    assert.equal(caps.ssoAvailable, true);
    assert.equal(caps.ssoEnabled, true);
    assert.equal(caps.localAdminOnly, true);
    assert.equal(caps.registrationEnabled, false);
  });

  it('distinguishes "enabled but unavailable" from "not offered"', () => {
    const down = projectLoginCapabilities(
      AuthConfigSchema.parse({ ...ssoDto, methods: { ...ssoDto.methods, sso: { enabled: true, available: false } } }),
    );
    assert.equal(down.ssoAvailable, false);
    assert.equal(down.ssoEnabled, true);
    const local = projectLoginCapabilities(
      AuthConfigSchema.parse({ mode: 'local', methods: { local: { enabled: true } } }),
    );
    assert.equal(local.ssoEnabled, false);
    assert.equal(local.localAdminOnly, false);
  });
});
