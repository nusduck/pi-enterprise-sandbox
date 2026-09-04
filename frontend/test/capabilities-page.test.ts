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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pageSrc = readFileSync(
  join(__dirname, '../src/pages/settings/CapabilitiesPage.tsx'),
  'utf8',
);

describe('CapabilitiesPage diagnostics and MCP status contracts', () => {
  it('prefers canonical MCP status over connection_status', () => {
    assert.match(
      pageSrc,
      /const status =\s*\n\s*s\.status \|\|\s*\n\s*\(s\.enabled === false \? 'disabled' : s\.connection_status \|\| 'configured'\)/,
    );
    assert.doesNotMatch(
      pageSrc,
      /s\.connection_status \|\| s\.status/,
    );
  });

  // 这条用例**在 2026-08-31 之前就是红的**：它读
  // `agent/src/extensions/constants.js`，而那个目录在 Wave 6 删除 Pi Extension
  // 时就没了；`extension-diagnostics-service` 也早已从 `.js` 转成 `.ts`。
  // 也就是说它守的是一份已经不存在的名单。
  //
  // 改成守现在真正成立的事（ADR 0009 D11 / 计划 H8.5）：诊断投影的是 DSH 的
  // host 工具面，来源标注不再是那批已删除的 Extension。
  it('projects the DSH host tool surface, not the deleted Pi extension list', () => {
    const diagnosticsSrc = readFileSync(
      join(__dirname, '../../agent/src/application/extension-diagnostics-service.ts'),
      'utf8',
    );
    assert.match(diagnosticsSrc, /Per-Run live authority/);
    assert.match(
      diagnosticsSrc,
      /dsh-host-tools/,
      '来源必须标成 DSH host 工具面——sandbox-bridge 那批 Extension 已经不存在了',
    );
    assert.doesNotMatch(diagnosticsSrc, /sandbox-bridge/);
    assert.doesNotMatch(diagnosticsSrc, /packages\/enterprise-agent-kit/);
    // 名单来自 runtime/policy/tool-names.ts 的唯一事实源（ADR 0009 D4），
    // 而它与 boot 后 `ctx.tools.schemas()` 的集合由 agent 侧 boot.test.ts 断言恰好相等。
    assert.match(diagnosticsSrc, /ENTERPRISE_DEFAULT_TOOLS/);
  });

  it('renders extension statuses and registry session scope on diagnostics tab', () => {
    assert.match(pageSrc, /\(diagnostics\.extensions \?\? \[\]\)\.map/);
    assert.match(pageSrc, /statusLabel\(ext\)/);
    assert.match(pageSrc, /Registry version/);
    assert.match(pageSrc, /diagnostics\.registry\?\.conversation_id/);
    assert.match(pageSrc, /diagnostics\.registry\?\.session_id/);
    assert.match(pageSrc, /diagnostics\.registry\?\.run_id/);
    assert.doesNotMatch(pageSrc, /owner_user_id/);
    assert.doesNotMatch(pageSrc, /organization_id/);
  });

  it('shows owner-scoped Skill drafts with enable and disable controls', () => {
    // 分层规则本身由下面的 `skill tiers` 用例按行为验；这里只守页面确实
    // 接了 enable/disable 这条通路和它的报错出口。
    assert.match(pageSrc, /setSkillEnabled/);
    assert.match(pageSrc, /draft \? 'Enable' : 'Disable'/);
    assert.match(pageSrc, /role="alert"/);
    // 动作按钮必须在动作区里——直接落在 flex-column 的卡片上会被拉成整行宽，
    // 草稿卡因此和 System 卡不是一个形状（2026-09-04）。
    assert.match(pageSrc, /mgmt-card-actions/);
  });

  it('provides dedicated Skill draft upload dropzone supporting .zip and .skill', () => {
    assert.match(pageSrc, /uploadSkillDraft/);
    assert.match(pageSrc, /accept=["']\.zip,\.skill,application\/zip["']/);
    assert.match(pageSrc, /Upload Skill Package/);
    assert.match(pageSrc, /mgmt-upload-dropzone/);
  });

  it('renders tab chips with item counts', () => {
    assert.match(pageSrc, /mgmt-chip-count/);
  });

  it('provides SettingsSubnav with secondary navigation for settings pages', () => {
    const subnavSrc = readFileSync(
      join(__dirname, '../src/app/layout/SettingsSubnav.tsx'),
      'utf8',
    );
    assert.match(subnavSrc, /\/settings\/capabilities/);
    assert.match(subnavSrc, /\/settings\/approvals/);
    assert.match(subnavSrc, /\/settings\/runs/);
    assert.match(subnavSrc, /settings-subnav/);
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
