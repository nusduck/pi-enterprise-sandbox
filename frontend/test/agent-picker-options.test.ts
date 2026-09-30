import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Agent } from '../src/shared/api';
import {
  normalizeSelectedAgentPickerValue,
  resolveAgentPickerOptions,
} from '../src/widgets/composer/agentPickerHelpers';

describe('agentPickerHelpers: 智能体选择器去重与选项解析', () => {
  it('当列表中包含租户默认智能体（通用智能体）时，合并为「通用智能体（默认）」，不产生重复项', () => {
    const agents: Agent[] = [
      {
        agent_id: '01DEFAULT00000000000000000',
        name: '通用智能体',
        status: 'active',
      },
      {
        agent_id: '01CUSTOM000000000000000001',
        name: '周报助手',
        status: 'active',
      },
    ];

    const { defaultAgent, options } = resolveAgentPickerOptions(agents);
    assert.equal(defaultAgent?.agent_id, '01DEFAULT00000000000000000');
    assert.equal(options.length, 2);
    assert.deepEqual(options[0], {
      value: '',
      label: '通用智能体（默认）',
      agent: agents[0],
    });
    assert.deepEqual(options[1], {
      value: '01CUSTOM000000000000000001',
      label: '周报助手',
      agent: agents[1],
    });
  });

  it('当列表中未包含通用智能体时，回退到「默认智能体」作为占位首项', () => {
    const agents: Agent[] = [
      {
        agent_id: '01CUSTOM000000000000000001',
        name: '专职助手',
        status: 'active',
      },
    ];

    const { defaultAgent, options } = resolveAgentPickerOptions(agents);
    assert.equal(defaultAgent, null);
    assert.equal(options.length, 2);
    assert.deepEqual(options[0], {
      value: '',
      label: '默认智能体',
      agent: null,
    });
    assert.deepEqual(options[1], {
      value: '01CUSTOM000000000000000001',
      label: '专职助手',
      agent: agents[0],
    });
  });

  it('归一化选中值：null、空字符串或默认智能体的 ID 均归一化为空字符串（对应默认项）', () => {
    const defaultAgent: Agent = {
      agent_id: '01DEFAULT00000000000000000',
      name: '通用智能体',
      status: 'active',
    };

    assert.equal(normalizeSelectedAgentPickerValue(null, defaultAgent), '');
    assert.equal(normalizeSelectedAgentPickerValue('', defaultAgent), '');
    assert.equal(normalizeSelectedAgentPickerValue('01DEFAULT00000000000000000', defaultAgent), '');
    assert.equal(normalizeSelectedAgentPickerValue('01OTHER000000000000000000', defaultAgent), '01OTHER000000000000000000');
  });
});
