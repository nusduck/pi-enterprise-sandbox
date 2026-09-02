/**
 * Capabilities page UI contracts (F5 diagnostics + MCP status truth).
 * Run: npm test -- test/capabilities-page.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
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
    assert.match(pageSrc, /draft-skill-root/);
    assert.match(pageSrc, /setSkillEnabled/);
    assert.match(pageSrc, /'Enable' : 'Disable'/);
    assert.match(pageSrc, /role="alert"/);
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

