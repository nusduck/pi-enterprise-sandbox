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
import { mcpStatus, usageTitle } from '../src/pages/settings/capabilityFormat.ts';
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
    // 停用那一侧用的是同一行的局部 `name`（分享按钮也要用）。断言跟着代码走，
    // 而不是反过来迁就断言——否则以后一次重命名会被当成功能回归。
    assert.match(settings, /setSkillEnabled\(name, false\)/);
    assert.match(settings, /role="alert"/);
  });

  it('申请共享的入口在个人 Skill 上，且带上「申请中」与撤回', () => {
    const settings = readFileSync(join(__dirname, '../src/widgets/settings/SettingsDialog.tsx'), 'utf8');
    // ADR 0015 §7.2 用户侧：已启用的 Skill 才能申请（未启用由服务端 409 拦）。
    assert.match(settings, /requestSkillShare\(name\)/);
    assert.match(settings, /withdrawSkillShare\(request\.requestId\)/);
    // 同名的 pending 申请还在时按钮不能还能再点（再点会 supersede 掉旧说明）。
    assert.match(settings, /pendingNames\.has\(name\)/);
    assert.match(settings, /申请中/);
    // 名字被组织层占用是可操作的拒绝原因，不能只显示「操作失败」。
    assert.match(settings, /SKILL_NAME_RESERVED_BY_ORG/);
    assert.match(settings, /SKILL_NOT_ENABLED/);
  });

  it('管理员 Skill 页在管理控制台里可达，并覆盖加载失败与并发冲突', () => {
    const shell = readFileSync(join(__dirname, '../src/app/layout/AdminShell.tsx'), 'utf8');
    assert.match(shell, /\/admin\/skills/);
    const router = readFileSync(join(__dirname, '../src/app/router/index.tsx'), 'utf8');
    assert.match(router, /path="\/admin\/skills"/);
    const page = readFileSync(join(__dirname, '../src/pages/settings/SkillAdminPage.tsx'), 'utf8');
    // 读取失败不能显示成空队列（那看起来像「没人申请」）。
    assert.match(page, /读取申请队列失败/);
    // 批准失败时申请保持 pending，页面只报错、不把行拿掉。
    assert.match(page, /setError\(\(err as Error\)\.message \|\| '操作失败'\)/);
    assert.match(page, /只支持 \.zip 或 \.skill 包/);
    assert.match(page, /单个包不能超过 50 MB/);
    // ADR 0015 D8：吊销时必须列出受影响的 AgentVersion 列表
    assert.match(page, /受影响的智能体版本/);
    assert.match(page, /affectedAgentVersionIds/);
    // 使用原生 <dialog> 和 showModal() 限制焦点，避免焦点移出弹窗
    assert.match(page, /<dialog/);
    assert.match(page, /\.showModal\(\)/);
    // 吊销失败时在弹窗内直接显示错误（不被弹窗遮盖），且保留原因输入草稿
    assert.match(page, /<b>吊销失败：<\/b>/);
    // 影响面支持分页；交互行为另由 smoke-skill-admin-ui.mjs 在浏览器验证。
    assert.match(page, /totalPages/);
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
  const org = (name: string) =>
    ({ name, source: 'org-skill-root', enabled: true }) as never;

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
    // org 层（ADR 0015 D5）：设计期的旧名 `shared-skill-root` 是系统层，不是共享层。
    assert.equal(skillSourceLabel(org('a')), 'Organization');
  });
});

describe('capabilities skill tiers（ADR 0015 D1）', () => {
  const draft = (name: string, published?: boolean) =>
    ({ name, source: 'draft-skill-root', enabled: false, ...(published === undefined ? {} : { published }) }) as never;
  const user = (name: string) =>
    ({ name, source: 'user-skill-root', enabled: true }) as never;
  const org = (name: string) =>
    ({ name, source: 'org-skill-root', enabled: true }) as never;
  const system = (name: string) =>
    ({ name, source: 'shared-skill-root', enabled: true }) as never;

  it('org 层单独成组，不并进用户层也不并进系统层', () => {
    const split = splitSkillTiers([
      system('pdf'),
      org('sales-weekly'),
      user('mine'),
      draft('wip', false),
    ]);
    assert.deepEqual(split.org.map((s) => s.name), ['sales-weekly']);
    assert.deepEqual(split.user.map((s) => s.name), ['mine']);
    assert.deepEqual(split.system.map((s) => s.name), ['pdf']);
    assert.deepEqual(split.drafts.map((s) => s.name), ['wip']);
  });

  it('同名同时出现在 org 与 user 层时两层各列一次（Run 里取 org，页面要看得见两处）', () => {
    const split = splitSkillTiers([org('dup'), user('dup')]);
    assert.deepEqual(split.org.map((s) => s.name), ['dup']);
    assert.deepEqual(split.user.map((s) => s.name), ['dup']);
    assert.deepEqual(split.system, []);
  });

  it('页面的来源筛选把 org 与用户分开，且分层规则取自 skillHelpers', () => {
    // 页面自己再判一次 `item.source` 就会与 skillHelpers 漂开——那正是
    // `shared-skill-root` 当初落到兜底分支的原因。
    assert.match(pageSrc, /isOrgSkill\(item\)/);
    assert.match(pageSrc, /\['org', '组织'\]/);
  });
});

describe('skill usage 分层（ADR 0015 §7.4）', () => {
  it('tooltip 只列出出现过的层', () => {
    assert.equal(
      usageTitle({ calls: 5, byScope: { system: 5, org: 0, user: 0 } }),
      '全组织近 7 天 skill 工具的调用次数；直接读取 Skill 文件不计入\n分层：系统 5',
    );
    assert.match(
      usageTitle({ calls: 7, byScope: { system: 2, org: 3, user: 2 } }),
      /分层：系统 2、组织 3、用户 2/,
    );
  });

  it('没有数据时只给基础说明，不编一个「分层：无」', () => {
    assert.equal(
      usageTitle(undefined),
      '全组织近 7 天 skill 工具的调用次数；直接读取 Skill 文件不计入',
    );
  });
});
