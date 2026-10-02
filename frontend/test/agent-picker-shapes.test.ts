import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Agent } from '../src/shared/api/index.ts';
import {
  normalizeSelectedAgentPickerValue,
  resolveAgentPickerOptions,
} from '../src/widgets/composer/agentPickerHelpers.ts';

const here = dirname(fileURLToPath(import.meta.url));
const readSrc = (...parts: string[]) => readFileSync(join(here, '..', 'src', ...parts), 'utf8');

const agent1: Agent = {
  agent_id: 'agent-general',
  org_id: 'org-1',
  name: '通用智能体',
  description: '日常办公与工程任务',
  visibility: 'org',
  version: 1,
  created_at: '2026-10-01',
  updated_at: '2026-10-01',
};

const agent2: Agent = {
  agent_id: 'agent-data',
  org_id: 'org-1',
  name: '数据分析智能体',
  description: '只读业务库图表生成',
  visibility: 'org',
  version: 1,
  created_at: '2026-10-01',
  updated_at: '2026-10-01',
};

describe('AgentPicker single vs multi-agent logic', () => {
  it('identifies single agent scenario and merges default agent option', () => {
    const single = [agent1];
    const { defaultAgent, options } = resolveAgentPickerOptions(single);
    assert.equal(defaultAgent?.agent_id, 'agent-general');
    assert.equal(options.length, 1);
    assert.equal(options[0].value, '');
    assert.match(options[0].label, /通用智能体（默认）/);
  });

  it('provides all options when multiple agents exist', () => {
    const multiple = [agent1, agent2];
    const { defaultAgent, options } = resolveAgentPickerOptions(multiple);
    assert.equal(defaultAgent?.agent_id, 'agent-general');
    assert.equal(options.length, 2);
    assert.equal(options[0].value, '');
    assert.equal(options[1].value, 'agent-data');
    assert.equal(options[1].label, '数据分析智能体');
  });

  it('normalizes selected agent value correctly', () => {
    assert.equal(normalizeSelectedAgentPickerValue(null, agent1), '');
    assert.equal(normalizeSelectedAgentPickerValue('agent-general', agent1), '');
    assert.equal(normalizeSelectedAgentPickerValue('agent-data', agent1), 'agent-data');
  });
});

describe('AgentPicker component structure & multi-agent invariants', () => {
  const tsx = readSrc('widgets', 'composer', 'AgentPicker.tsx');
  const css = readSrc('widgets', 'composer', 'agentPicker.module.css');

  it('enforces single-agent and readOnly states: non-clickable chip without arrow', () => {
    // In tsx, canPick requires !readOnly && !disabled && agents.length > 1
    assert.match(tsx, /const canPick = !readOnly && !disabled && agents\.length > 1/);
    assert.match(tsx, /disabled=\{!canPick\}/);
    // Arrow is conditionally rendered only when canPick is true
    assert.match(tsx, /\{canPick \? \(\s*<IconChevronDown/);
  });

  it('supports Popover with search for large agent lists (>6) and immutable notice', () => {
    assert.match(tsx, /agents\.length > 6/);
    assert.match(tsx, /会话开始后智能体不可更换/);
    assert.match(tsx, /aria-haspopup=\{canPick \? 'dialog' : undefined\}/);
  });

  it('defines 32px pill chip and popover styles using design tokens', () => {
    assert.match(css, /height:\s*32px/);
    assert.match(css, /border-radius:\s*var\(--radius-pill\)/);
    assert.match(css, /background:\s*var\(--material-fill\)/);
    assert.match(css, /\.popover/);
    assert.match(css, /\.chipStatic/);
  });
});
