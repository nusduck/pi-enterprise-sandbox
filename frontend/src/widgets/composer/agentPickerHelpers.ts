/**
 * 智能体选择器选项构建与归一化。
 *
 * 组织默认智能体（`通用智能体`）由后端自动维护，在智能体列表里作为独立行返回；
 * 选择器必须把它与「默认」选项合二为一（展示为「通用智能体（默认）」），
 * 避免下拉框里同时出现「默认智能体」和「通用智能体」两项重复。
 */
import type { Agent } from '../../shared/api';
import { isDefaultAgentName } from '../conversation-sidebar/sidebarModel';

export interface AgentPickerOption {
  readonly value: string;
  readonly label: string;
  readonly agent: Agent | null;
}

export function resolveAgentPickerOptions(agents: readonly Agent[]): {
  defaultAgent: Agent | null;
  options: AgentPickerOption[];
} {
  const defaultAgent = agents.find((a) => isDefaultAgentName(a.name)) ?? null;
  const options: AgentPickerOption[] = [
    {
      value: '',
      label: defaultAgent ? `${defaultAgent.name}（默认）` : '默认智能体',
      agent: defaultAgent,
    },
    ...agents
      .filter((a) => a !== defaultAgent)
      .map((a) => ({
        value: a.agent_id,
        label: a.name,
        agent: a,
      })),
  ];
  return { defaultAgent, options };
}

export function normalizeSelectedAgentPickerValue(
  selectedAgentId: string | null | undefined,
  defaultAgent: Agent | null,
): string {
  if (!selectedAgentId || (defaultAgent && selectedAgentId === defaultAgent.agent_id)) {
    return '';
  }
  return selectedAgentId;
}
