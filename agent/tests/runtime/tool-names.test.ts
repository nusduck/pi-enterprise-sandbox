/**
 * ADR 0009 D4 / 计划 H1：工具名的唯一事实源、平台层 fail-fast、存量 toolPolicy 的别名投影。
 *
 * 这些用例的共同点是**空实现过不了**：
 * - 别名投影那条，如果 `projectLegacyToolNames` 原样返回，新名就取不到旧名的决定；
 * - fail-fast 那条，如果断言没接上，非法 key 会静默通过；
 * - 退役理由码那条，如果不区分退役与未知，拿到的是 `UNKNOWN_TOOL`。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ASK_USER_TOOL_NAME,
  LEGACY_TOOL_NAME_ALIASES,
  RETIRED_TOOL_REASON_CODE,
  SANDBOX_TOOL_NAMES,
  isRetiredToolName,
  resolveToolNameAlias,
} from '../../src/runtime/policy/tool-names.js';
import { classifyTool, decideFromRiskTable } from '../../src/runtime/policy/risk-table.js';
import { loadToolRiskPolicy } from '../../src/infrastructure/dsh/tool-risk-policy.js';
import { buildAgentVersionToolRiskBindings } from '../../src/application/tool-risk-bindings.js';

test('事实源只有一份：分类器与风险表都认同一批本地工具', () => {
  for (const name of SANDBOX_TOOL_NAMES) {
    assert.equal(classifyTool(name), 'local_low', `${name} 应被分类为 local_low`);
    assert.equal(
      decideFromRiskTable(name).decision,
      'allow',
      `${name} 默认应放行（fail-closed 之下漏一个就是整片被拒）`,
    );
  }
  assert.equal(classifyTool(ASK_USER_TOOL_NAME), 'internal_interaction');
});

test('旧 Pi 名字一个都不在新工具面里（否则改名没改干净）', () => {
  for (const legacy of Object.keys(LEGACY_TOOL_NAME_ALIASES)) {
    assert.equal(
      SANDBOX_TOOL_NAMES.includes(legacy),
      false,
      `${legacy} 是旧名，不该同时出现在新名单里`,
    );
  }
});

test('H1.9 退役能力给稳定理由码，不是 UNKNOWN_TOOL', () => {
  for (const retired of ['memory_write', 'memory_search']) {
    assert.equal(isRetiredToolName(retired), true);
    const decision = decideFromRiskTable(retired);
    assert.equal(decision.decision, 'deny');
    assert.equal(
      decision.reasonCode,
      RETIRED_TOOL_REASON_CODE,
      '退役是显式决定，不能和「没见过的工具」共用一个理由码',
    );
  }
  // 对照：真正没见过的工具仍然是 UNKNOWN_TOOL
  assert.equal(decideFromRiskTable('totally_made_up').reasonCode, 'UNKNOWN_TOOL');
});

test('H1.5 平台层 fail-fast：风险表里出现不存在的工具名就抛', () => {
  assert.throws(
    () =>
      loadToolRiskPolicy(
        { tools: { definitely_not_a_tool: 'high' } },
        { field: 'test', assertKnownNames: true },
      ),
    /definitely_not_a_tool/,
    '平台层必须拒绝死配置：分类器 fail-closed，拼错的 key 只会表现为「那个工具被拒」',
  );
  // mcp 前缀与 server::tool 不由我们命名，必须放过
  assert.doesNotThrow(() =>
    loadToolRiskPolicy(
      { tools: { 'mcp__github__*': 'high', 'github::create_pr': 'high' } },
      { field: 'test', assertKnownNames: true },
    ),
  );
  // 租户层不开断言：存量快照可以带旧名
  assert.doesNotThrow(() =>
    loadToolRiskPolicy({ tools: { ls: 'low' } }, { field: 'test' }),
  );
});

test('仓库里的 config/agent/tool-risk.json 通过平台层断言', async () => {
  const { resolveToolRiskPolicy } = await import('../../config.js');
  assert.doesNotThrow(() => resolveToolRiskPolicy({}));
});

/** 建一个只带 toolPolicy 的最小 AgentVersion 快照。 */
function versionWith(toolPolicy: Record<string, unknown>) {
  return { configJson: { toolPolicy } };
}

test('H1.8 存量 toolPolicy 的旧名被投影成新名', () => {
  const bindings = buildAgentVersionToolRiskBindings(
    versionWith({ tools: { ls: 'deny', spawn_subagent: 'deny', ask_user: 'allow' } }),
  );
  const policy = bindings.agentVersionToolPolicy as Record<string, unknown>;
  assert.equal(policy['glob'], 'deny', 'ls → glob');
  assert.equal(policy['subagent'], 'deny', 'spawn_subagent → subagent');
  assert.equal(policy[ASK_USER_TOOL_NAME], 'allow', 'ask_user → ask_user_question');
  assert.equal('ls' in policy, false, '旧名不该留在投影结果里');
});

test('H1.8 新名优先：快照同时写了旧名和新名时，旧名不覆盖新名', () => {
  const bindings = buildAgentVersionToolRiskBindings(
    versionWith({ tools: { glob: 'allow', ls: 'deny' } }),
  );
  const policy = bindings.agentVersionToolPolicy as Record<string, unknown>;
  assert.equal(policy['glob'], 'allow', '显式写的新名必须赢');
});

test('H1.8 退役能力不进投影结果（理由码由风险表给）', () => {
  const bindings = buildAgentVersionToolRiskBindings(
    versionWith({ tools: { memory_write: 'allow' } }),
  );
  const policy = bindings.agentVersionToolPolicy;
  assert.equal(policy === undefined || !('memory_write' in policy), true);
});

test('H1.8 mcp 名字原样穿过投影', () => {
  const bindings = buildAgentVersionToolRiskBindings(
    versionWith({ tools: { 'mcp__github__create_pr': 'deny' } }),
  );
  const policy = bindings.agentVersionToolPolicy as Record<string, unknown>;
  assert.equal(policy['mcp__github__create_pr'], 'deny');
});

test('resolveToolNameAlias 对当前名字是恒等的', () => {
  for (const name of [...SANDBOX_TOOL_NAMES, ASK_USER_TOOL_NAME]) {
    assert.equal(resolveToolNameAlias(name), name);
  }
});

test('H7.3 未配到的 mcp__* 工具落到 high，不会掉到 allow', async () => {
  const { buildRunRiskResolver } = await import('../../src/application/tool-risk-resolver.js');
  const resolve = buildRunRiskResolver(null, null);
  // 出厂包对超长/非法名会规范化并追加 12 位十六进制哈希——那种名字精确 key
  // 匹配不上。漏了不能变成放行。
  assert.equal(resolve('mcp__github__create_pr'), 'high');
  assert.equal(resolve('mcp__github__some_very_long_name_a1b2c3d4e5f6'), 'high');
  // 非 mcp 工具不受这条兜底影响，仍走风险表的分类默认。
  assert.equal(resolve('read'), undefined);
});

test('H7.3 租户层只能收紧：配 low 也不会把平台的 high 降下来', async () => {
  const { buildRunRiskResolver } = await import('../../src/application/tool-risk-resolver.js');
  const platform = { tools: { bash: 'high' } };
  const version = { configJson: { toolPolicy: { riskLevels: { bash: 'low' } } } };
  assert.equal(
    buildRunRiskResolver(platform, version)('bash'),
    'high',
    '一个 org 不能靠发新 AgentVersion 把平台的审批闸门关掉',
  );
  assert.equal(
    buildRunRiskResolver(platform, { configJson: { toolPolicy: { riskLevels: { bash: 'critical' } } } })('bash'),
    'critical',
    '收紧是允许的',
  );
});
