import { useMemo, useRef, useState } from 'react';
import type { Agent } from '../../shared/api';
import {
  normalizeSelectedAgentPickerValue,
  resolveAgentPickerOptions,
} from './agentPickerHelpers';
import { agentTone, isDefaultAgentName } from '../conversation-sidebar/sidebarModel';
import { IconCheck, IconChevronDown, IconSearch } from '../../shared/ui/Icons';
import { Popover } from '../../shared/ui/Popover';
import s from './agentPicker.module.css';

export type AgentPickerProps = {
  agents: Agent[];
  selectedAgentId: string | null;
  onSelect: (agentId: string | null) => void;
  disabled?: boolean;
  readOnly?: boolean;
};

export function AgentPicker({
  agents,
  selectedAgentId,
  onSelect,
  disabled = false,
  readOnly = false,
}: AgentPickerProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const { defaultAgent } = useMemo(
    () => resolveAgentPickerOptions(agents),
    [agents],
  );

  const selectedValue = normalizeSelectedAgentPickerValue(selectedAgentId, defaultAgent);
  const currentAgent =
    agents.find((agent) => agent.agent_id === selectedAgentId) ||
    defaultAgent ||
    agents[0] ||
    null;

  const canPick = !readOnly && !disabled && agents.length > 1;

  const filteredAgents = useMemo(() => {
    if (!query.trim()) return agents;
    const q = query.trim().toLowerCase();
    return agents.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        (a.description && a.description.toLowerCase().includes(q)),
    );
  }, [agents, query]);

  if (!currentAgent) {
    return null;
  }

  const toneIdx = agentTone(currentAgent.agent_id);
  const initial = (currentAgent.name || '智').slice(0, 1);

  return (
    <div className={s.wrapper}>
      <button
        ref={triggerRef}
        type="button"
        disabled={!canPick}
        aria-haspopup={canPick ? 'dialog' : undefined}
        aria-expanded={canPick ? open : undefined}
        title={
          readOnly
            ? '会话已绑定此智能体，不可更换'
            : currentAgent.description || '选择新会话使用的智能体'
        }
        className={`${s.chip} ${open ? s.chipOpen : ''} ${!canPick ? s.chipStatic : ''}`}
        onClick={() => {
          if (canPick) setOpen((v) => !v);
        }}
      >
        <span
          className={`${s.avatar} ${s[`t${toneIdx}`]}`}
          aria-hidden="true"
        >
          {initial}
        </span>
        <span className={s.agentName}>{currentAgent.name}</span>
        {canPick ? (
          <IconChevronDown size={13} className={s.arrow} />
        ) : null}
      </button>

      {canPick ? (
        <Popover
          open={open}
          onClose={() => {
            setOpen(false);
            setQuery('');
          }}
          triggerRef={triggerRef}
          placement="top-start"
          ariaLabel="选择智能体"
          className={s.popover}
        >
          {agents.length > 6 ? (
            <div className={s.searchBox}>
              <IconSearch size={14} className={s.searchIcon} />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索智能体"
                aria-label="搜索智能体"
                className={s.searchInput}
              />
            </div>
          ) : null}

          <div className={s.listHeader}>可用智能体 · {filteredAgents.length}</div>

          <div className={s.list}>
            {filteredAgents.map((agent) => {
              const isDefault = isDefaultAgentName(agent.name);
              const isSelected =
                agent.agent_id === selectedValue ||
                (!selectedValue && isDefault);
              const itemTone = agentTone(agent.agent_id);
              const itemInitial = (agent.name || '智').slice(0, 1);

              return (
                <button
                  key={agent.agent_id}
                  type="button"
                  aria-pressed={isSelected}
                  className={`${s.agentItem} ${isSelected ? s.itemSelected : ''}`}
                  onClick={() => {
                    onSelect(isDefault ? null : agent.agent_id);
                    setOpen(false);
                    setQuery('');
                  }}
                >
                  <div className={`${s.itemAvatar} ${s[`t${itemTone}`]}`} aria-hidden="true">
                    {itemInitial}
                  </div>
                  <div className={s.itemContent}>
                    <div className={s.itemRow}>
                      <span className={s.itemName}>{agent.name}</span>
                      {isDefault ? <span className={s.defaultBadge}>默认</span> : null}
                    </div>
                    {agent.description ? (
                      <div className={s.itemDesc} title={agent.description}>
                        {agent.description}
                      </div>
                    ) : null}
                  </div>
                  {isSelected ? (
                    <IconCheck size={16} className={s.checkIcon} />
                  ) : null}
                </button>
              );
            })}
          </div>

          <div className={s.popoverFooter}>会话开始后智能体不可更换</div>
        </Popover>
      ) : null}
    </div>
  );
}
