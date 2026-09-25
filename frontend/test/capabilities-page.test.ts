/**
 * Capabilities page UI contracts (F5 diagnostics + MCP status truth).
 * Run: npm test -- test/capabilities-page.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isPendingDraft,
  skillSourceLabel,
  splitSkillTiers,
} from '../src/pages/settings/skillHelpers.ts';
import { mcpStatus } from '../src/pages/settings/capabilityFormat.ts';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pageSrc = readFileSync(
  join(__dirname, '../src/pages/settings/CapabilitiesPage.tsx'),
  'utf8',
);

describe('capabilities tables', () => {
  it('prefers the canonical MCP status over connection_status', () => {
    assert.equal(mcpStatus({ status: 'error', connection_status: 'connected' }), 'error');
    assert.equal(mcpStatus({ connection_status: 'connected' }), 'connected');
    assert.equal(mcpStatus({ enabled: false, connection_status: 'connected' }), 'disabled');
    assert.equal(mcpStatus({}), 'configured');
  });

  // 这条用例**在 2026-08-31 之前就是红的**：它读
  // `agent/src/extensions/constants.js`，而那个目录在 Wave 6 删除旧引擎 Extension
  // 时就没了。改成守现在真正成立的事（ADR 0009 D11 / 计划 H8.5）：诊断投影的是
  // DSH 的 host 工具面。前端不再展示 Extension 诊断（2026-09-25），这条守的是 agent 侧。
  it('projects the DSH host tool surface, not the deleted legacy extension list', () => {
    const diagnosticsSrc = readFileSync(
      join(__dirname, '../../agent/src/application/extension-diagnostics-service.ts'),
      'utf8',
    );
    assert.match(diagnosticsSrc, /Per-Run live authority/);
    assert.match(diagnosticsSrc, /dsh-host-tools/);
    assert.doesNotMatch(diagnosticsSrc, /sandbox-bridge/);
    assert.doesNotMatch(diagnosticsSrc, /packages\/enterprise-agent-kit/);
    assert.match(diagnosticsSrc, /ENTERPRISE_DEFAULT_TOOLS/);
  });

  it('no longer shows the removed Extension concept', () => {
    assert.doesNotMatch(pageSrc, /Extension|getExtensionDiagnostics/);
    assert.match(pageSrc, /MCP 服务/);
  });

  it('manages the user\'s own Skill drafts in the settings dialog', () => {
    const settings = readFileSync(join(__dirname, '../src/widgets/settings/SettingsDialog.tsx'), 'utf8');
    assert.match(settings, /uploadSkillDraft/);
    assert.match(settings, /accept="\.zip,\.skill"/);
    assert.match(settings, /setSkillEnabled\(String\(skill\.name\), true\)/);
    assert.match(settings, /setSkillEnabled\(String\(skill\.name\), false\)/);
    assert.match(settings, /role="alert"/);
  });

  it('lists admin pages in the admin console and keeps /settings links working', () => {
    const shell = readFileSync(join(__dirname, '../src/app/layout/AdminShell.tsx'), 'utf8');
    for (const path of ['/admin/runs', '/admin/approvals', '/admin/agents', '/admin/capabilities', '/admin/a2a']) {
      assert.match(shell, new RegExp(path.replace(/\//g, '\\/')));
    }
    assert.match(shell, /需要管理员权限/);
    const router = readFileSync(join(__dirname, '../src/app/router/index.tsx'), 'utf8');
    assert.match(router, /path="\/settings\/:tab"/);
    assert.match(router, /path="\/c\/:conversationId"/);
    assert.match(router, /Navigate to="\/admin\/runs"/);
  });
});

describe('skill tiers', () => {
  const draft = (name: string, published?: boolean) =>
    ({ name, source: 'draft-skill-root', enabled: false, ...(published === undefined ? {} : { published }) }) as never;
  const user = (name: string) =>
    ({ name, source: 'user-skill-root', enabled: true }) as never;
  const system = (name: string) =>
    ({ name, source: 'shared-skill-root', enabled: true }) as never;

  it('启用后的草稿不再列进 Drafts —— 否则同一个名字出现两次', () => {
    // 启用是复制字节，草稿不删（skills/enablement.ts），所以后端一直会返回它。
    const split = splitSkillTiers([
      draft('weather-query', true),
      user('weather-query'),
      draft('not-yet-enabled', false),
      system('pdf'),
    ]);
    assert.deepEqual(split.drafts.map((s) => s.name), ['not-yet-enabled']);
    assert.deepEqual(split.user.map((s) => s.name), ['weather-query']);
    assert.deepEqual(split.system.map((s) => s.name), ['pdf']);
    assert.equal(split.publishedFromDraft.has('weather-query'), true);
    assert.equal(split.publishedFromDraft.has('not-yet-enabled'), false);
  });

  it('老后端没有 published 字段时，草稿仍按待启用处理', () => {
    assert.equal(isPendingDraft(draft('legacy')), true);
    assert.equal(isPendingDraft(draft('legacy', false)), true);
    assert.equal(isPendingDraft(draft('legacy', true)), false);
    assert.equal(isPendingDraft(user('legacy')), false);
  });

  it('来源列按层给出稳定文案', () => {
    assert.equal(skillSourceLabel(draft('a')), 'Draft');
    assert.equal(skillSourceLabel(user('a')), 'User');
    assert.equal(skillSourceLabel(system('a')), 'System');
  });
});
