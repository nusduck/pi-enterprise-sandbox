/**
 * P1b：登录能力投影必须按服务端事实，SSO 不可用时**不得**出现可用入口。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AuthConfigSchema,
  DEFAULT_SSO_LABEL,
  loginMethodLabel,
  noLoginMethodMessage,
  projectLoginCapabilities,
} from '../src/shared/schemas/auth.ts';

const LOCKED_DTO = {
  mode: 'local',
  methods: {
    local: { enabled: true, registration_enabled: false },
    sso: { enabled: false, available: false, label: '公司 SSO' },
  },
  profile_policy: { editable_fields: ['display_name', 'email', 'notify_run_complete'] },
};

describe('auth config DTO', () => {
  it('parses the locked local DTO without exposing secrets', () => {
    const parsed = AuthConfigSchema.parse(LOCKED_DTO);
    assert.equal(parsed.mode, 'local');
    assert.equal(parsed.methods?.local?.enabled, true);
    assert.equal(parsed.methods?.local?.registration_enabled, false);
    assert.deepEqual(parsed.profile_policy?.editable_fields, [
      'display_name',
      'email',
      'notify_run_complete',
    ]);
  });

  it('keeps registration closed when the server omits the flag', () => {
    const parsed = AuthConfigSchema.parse({ mode: 'local', methods: { local: { enabled: true } } });
    assert.equal(parsed.methods?.local?.registration_enabled, false);
  });

  it('never treats a disabled sso as available, even when the flag is missing', () => {
    const caps = projectLoginCapabilities(AuthConfigSchema.parse(LOCKED_DTO));
    assert.equal(caps.localEnabled, true);
    assert.equal(caps.registrationEnabled, false);
    assert.equal(caps.ssoAvailable, false);
    assert.equal(caps.ssoLabel, '公司 SSO');
    assert.equal(noLoginMethodMessage(caps), null);
  });

  it('requires both enabled and available before the sso entry is usable', () => {
    const enabledOnly = projectLoginCapabilities(
      AuthConfigSchema.parse({ mode: 'hybrid', methods: { sso: { enabled: true } } }),
    );
    assert.equal(enabledOnly.ssoAvailable, false);

    const both = projectLoginCapabilities(
      AuthConfigSchema.parse({
        mode: 'hybrid',
        methods: { sso: { enabled: true, available: true, label: 'ACME SSO' } },
      }),
    );
    assert.equal(both.ssoAvailable, true);
    assert.equal(both.ssoLabel, 'ACME SSO');
  });

  it('falls back to the fixed label instead of hiding the sso entry', () => {
    const caps = projectLoginCapabilities(
      AuthConfigSchema.parse({ mode: 'local', methods: { sso: { enabled: false } } }),
    );
    assert.equal(caps.ssoLabel, DEFAULT_SSO_LABEL);
  });

  it('flags an unknown mode instead of silently calling it local', () => {
    const caps = projectLoginCapabilities(
      AuthConfigSchema.parse({ mode: 'kerberos', methods: { local: { enabled: false } } }),
    );
    assert.equal(caps.modeDiagnosed, true);
    assert.equal(caps.localEnabled, false);
    const message = noLoginMethodMessage(caps);
    assert.match(String(message), /kerberos/);
  });

  it('reports no available login method as a visible state, not an empty form', () => {
    const caps = projectLoginCapabilities(
      AuthConfigSchema.parse({
        mode: 'sso',
        methods: { local: { enabled: false }, sso: { enabled: true, available: false } },
      }),
    );
    assert.equal(caps.localEnabled, false);
    assert.equal(caps.ssoAvailable, false);
    assert.match(String(noLoginMethodMessage(caps)), /未开放任何登录方式/);
  });

  it('treats a missing config as no capability at all', () => {
    const caps = projectLoginCapabilities(null);
    assert.deepEqual(caps, {
      mode: null,
      localEnabled: false,
      registrationEnabled: false,
      ssoAvailable: false,
      ssoEnabled: false,
      localAdminOnly: false,
      ssoLabel: DEFAULT_SSO_LABEL,
      defaultEditableFields: [],
      modeDiagnosed: false,
    });
  });
});

describe('auth config contract is fail-closed', () => {
  // 坏 DTO 不能解析成功：否则 UI 会把「配置加载坏了」当成「部署没有登录方式」。
  const malformed: Array<[string, unknown]> = [
    ['empty object', {}],
    ['empty methods', { mode: 'local', methods: {} }],
    ['missing methods', { mode: 'local' }],
    ['missing mode', { methods: { local: { enabled: true } } }],
    ['blank mode', { mode: '', methods: { local: { enabled: true } } }],
    ['non-string mode', { mode: 42, methods: { local: { enabled: true } } }],
    ['null local declaration', { mode: 'local', methods: { local: null } }],
  ];

  for (const [label, dto] of malformed) {
    it(`rejects ${label}`, () => {
      assert.equal(AuthConfigSchema.safeParse(dto).success, false);
    });
  }

  it('keeps an unknown but non-empty mode for diagnosis instead of rejecting it', () => {
    const caps = projectLoginCapabilities(
      AuthConfigSchema.parse({ mode: 'kerberos', methods: { local: { enabled: false } } }),
    );
    assert.equal(caps.mode, 'kerberos');
    assert.equal(caps.modeDiagnosed, true);
    assert.match(String(noLoginMethodMessage(caps)), /kerberos/);
  });

  it('accepts a recognized declaration that is explicitly disabled', () => {
    const parsed = AuthConfigSchema.parse({
      mode: 'sso',
      methods: {
        local: { enabled: false, registration_enabled: false },
        sso: { enabled: false, available: false },
      },
    });
    const caps = projectLoginCapabilities(parsed);
    assert.equal(caps.localEnabled, false);
    assert.equal(caps.registrationEnabled, false);
    assert.equal(caps.ssoAvailable, false);
    assert.match(String(noLoginMethodMessage(caps)), /未开放任何登录方式/);
  });

  it('keeps sso-only declarations fail-closed on omitted flags', () => {
    const parsed = AuthConfigSchema.parse({ mode: 'hybrid', methods: { sso: {} } });
    assert.equal(parsed.methods?.sso?.enabled, false);
    assert.equal(parsed.methods?.sso?.available, false);
    assert.equal(projectLoginCapabilities(parsed).ssoAvailable, false);
  });
});

describe('login source labels', () => {
  it('shows the real source field and never invents one', () => {
    assert.equal(loginMethodLabel('local'), '账号密码');
    assert.equal(loginMethodLabel('sso'), '公司 SSO');
    assert.equal(loginMethodLabel(null), '—');
    assert.equal(loginMethodLabel(undefined), '—');
    assert.equal(loginMethodLabel('webauthn'), 'webauthn');
  });
});
