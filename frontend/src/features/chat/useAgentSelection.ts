/**
 * Agent 选择：org 内可选的智能体，以及**新会话**要用哪一个。
 *
 * 两条来自设计文档的约束直接体现在这个 hook 的形状里
 * （`docs/design/multi-agent-selection.md`）：
 *
 * - **只记 agentId，不记 agentVersionId**（D1）。admin 一旦切活跃版本，
 *   前端缓存的 versionId 立刻过期；版本解析永远发生在服务端的事务内。
 * - **绑定发生在建会话时，此后不可变**（D2）。所以 `selectedAgentId` 只对
 *   "还没有 conversationId"的那一刻有意义；会话一旦存在，当前 Agent 由会话
 *   自己说了算，选择器不再参与。
 *
 * 列表拿不到时（未登录、目录暂时不可用）静默降级为空：单 Agent 的既有体验
 * 不能因为一个新面板的失败而中断。
 */
import { useCallback, useMemo, useState } from 'react';
import { listAgents, type Agent } from '../../shared/api';

export interface AgentSelection {
  /** org 内 status=active 的智能体；只有一个时前端不渲染选择器。 */
  agents: Agent[];
  /** 新会话要用的 Agent；null = 用租户默认 Agent（与多 Agent 上线前一致）。 */
  selectedAgentId: string | null;
  setSelectedAgentId: (agentId: string | null) => void;
  refreshAgents: () => Promise<void>;
  /** agentId → 展示名。会话头部用它显示"这个会话绑在哪个 Agent 上"。 */
  agentNameById: (agentId: string | null | undefined) => string | null;
  /** 登出是身份边界：丢掉上一个账号的目录。 */
  resetAgents: () => void;
}

export function useAgentSelection(): AgentSelection {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgentId, setSelectedAgentIdState] = useState<string | null>(null);

  const refreshAgents = useCallback(async () => {
    try {
      const list = await listAgents();
      const selectable = list.filter(
        (agent) => String(agent.status || '').toLowerCase() === 'active',
      );
      setAgents(selectable);
      // 选中的 Agent 被停用或删掉时回落到"租户默认"，而不是继续送一个
      // 服务端会拒绝的 id。
      setSelectedAgentIdState((current) =>
        current && selectable.some((agent) => agent.agent_id === current)
          ? current
          : null,
      );
    } catch {
      setAgents([]);
      setSelectedAgentIdState(null);
    }
  }, []);

  const setSelectedAgentId = useCallback((agentId: string | null) => {
    setSelectedAgentIdState(String(agentId || '').trim() || null);
  }, []);

  const nameIndex = useMemo(() => {
    const index = new Map<string, string>();
    for (const agent of agents) index.set(agent.agent_id, agent.name);
    return index;
  }, [agents]);

  const agentNameById = useCallback(
    (agentId: string | null | undefined) =>
      (agentId && nameIndex.get(agentId)) || null,
    [nameIndex],
  );

  const resetAgents = useCallback(() => {
    setAgents([]);
    setSelectedAgentIdState(null);
  }, []);

  return {
    agents,
    selectedAgentId,
    setSelectedAgentId,
    refreshAgents,
    agentNameById,
    resetAgents,
  };
}
