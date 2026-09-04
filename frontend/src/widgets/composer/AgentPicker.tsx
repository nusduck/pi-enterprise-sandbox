/**
 * 建会话时选哪个智能体。
 *
 * 只在**新会话**（还没有 conversationId）且 org 内多于一个 Agent 时渲染：
 * 一个会话绑定一个 Agent，绑定发生在建会话时且此后不可变
 * （`docs/design/multi-agent-selection.md` D2），所以会话开始之后这个控件
 * 不该出现——留着它只会让用户以为中途能换。
 *
 * 用原生 `<select>` 而不是 ModelPicker 那套自绘菜单：选项是短名字，没有
 * 每项的价格/上下文窗口要排版，原生控件的键盘与移动端行为反而更好。
 */
import type { Agent } from '../../shared/api';

export type AgentPickerProps = {
  agents: Agent[];
  selectedAgentId: string | null;
  onSelect: (agentId: string | null) => void;
  disabled?: boolean;
};

export function AgentPicker({
  agents,
  selectedAgentId,
  onSelect,
  disabled = false,
}: AgentPickerProps) {
  const selected = agents.find((agent) => agent.agent_id === selectedAgentId);
  return (
    <label className="agent-picker">
      <span className="agent-picker-label">Agent</span>
      <select
        className="agent-picker-select"
        value={selectedAgentId ?? ''}
        disabled={disabled}
        title={selected?.description || 'Choose the agent for this new conversation'}
        aria-label="Agent for this new conversation"
        onChange={(event) => onSelect(event.target.value || null)}
      >
        {/* 空值 = 不传 agent_id，服务端用租户默认 Agent（向后兼容）。 */}
        <option value="">Default</option>
        {agents.map((agent) => (
          <option key={agent.agent_id} value={agent.agent_id}>
            {agent.name}
          </option>
        ))}
      </select>
    </label>
  );
}
