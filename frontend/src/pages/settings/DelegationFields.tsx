import type { ConfigDiagnostic } from '../../shared/api/agents';
import type { CatalogState } from './agentHelpers';
import {
  delegationRows,
  toggleDelegation,
  type DelegationCandidate,
  type DelegationKey,
  type DelegationRow,
} from './delegationHelpers';
import s from './agents.module.css';

type GroupProps = {
  title: string;
  field: DelegationKey;
  selected: string[];
  candidates: CatalogState<DelegationCandidate>;
  max: number;
  selfName: string;
  errors: ConfigDiagnostic[];
  disabled?: boolean;
  empty: string;
  footer: string;
  badge?: string;
  onChange: (next: string[]) => void;
};

function errorAt(errors: ConfigDiagnostic[], path: string): string | null {
  return errors.find((error) => error.path === path)?.message ?? null;
}

function staleNote(row: DelegationRow, field: DelegationKey, selfName: string, available: boolean): string {
  if (field === 'agents' && row.id === selfName.trim()) return '委派给自己请用同构子任务（subagent）';
  if (!available) return '目录暂不可用，只能移除';
  return field === 'agents' ? '组织内找不到这个名字' : '当前部署未登记';
}

function DelegationGroup({ title, field, selected, candidates, max, selfName, errors, disabled, empty, footer, badge, onChange }: GroupProps) {
  // With the directory unavailable every draft entry becomes a keep-only row.
  const rows = delegationRows(selected, candidates.available ? candidates.items : []);
  const full = selected.length >= max;
  return (
    <fieldset className={s.mcpCard}>
      <div className={s.mcpHead}>
        <b>{title}</b>
        <span className={s.sp} />
        <span className={s.tag}>已选 {selected.length} / {max}</span>
      </div>
      {candidates.loading ? <p className={s.hint}>正在读取…</p> : null}
      {!candidates.loading && !candidates.available ? (
        <p className={s.warnBox} role="status">
          候选目录暂不可用{candidates.error ? `（${candidates.error}）` : ''}。草稿里已有的条目会保留，恢复前不能新增。
        </p>
      ) : null}
      <div className={s.delegList}>
        {rows.map((row) => {
          const canCheck = row.checked || (row.selectable && !full);
          const error = row.draftIndex >= 0 ? errorAt(errors, `delegation.${field}[${row.draftIndex}]`) : null;
          const note = row.stale ? staleNote(row, field, selfName, candidates.available) : row.note;
          return (
            <label key={row.id} className={`${s.delegRow}${row.stale ? ` ${s.permStale}` : ''}`}>
              <input
                type="checkbox"
                checked={row.checked}
                disabled={disabled || !canCheck}
                onChange={(event) => onChange(toggleDelegation(selected, row.id, event.target.checked))}
              />
              <b>{row.label}</b>
              {row.label !== row.id ? <code>{row.id}</code> : null}
              <small className={s.delegDesc}>
                {row.stale ? '' : row.description || '（没有描述：模型不知道它擅长什么）'}
              </small>
              {note ? <span className={s.tag}>{row.stale ? `已保留 · ${note}` : note}</span> : null}
              {badge && !row.stale ? <span className={s.tag}>{badge}</span> : null}
              {error ? <small className={`${s.fieldError} ${s.delegError}`}>{error}</small> : null}
            </label>
          );
        })}
        {!rows.length && candidates.available ? <p className={s.hint}>{empty}</p> : null}
      </div>
      {full ? <p className={s.hint}>已达上限 {max}。</p> : null}
      <p className={s.hint}>{footer}</p>
      {errorAt(errors, `delegation.${field}`) ? <small className={s.fieldError}>{errorAt(errors, `delegation.${field}`)}</small> : null}
    </fieldset>
  );
}

export type DelegationFieldsProps = {
  agents: string[];
  remoteAgents: string[];
  localCandidates: CatalogState<DelegationCandidate>;
  remoteCandidates: CatalogState<DelegationCandidate>;
  maxAgents: number;
  maxRemoteAgents: number;
  selfName: string;
  errors: ConfigDiagnostic[];
  disabled?: boolean;
  onChange: (field: DelegationKey, next: string[]) => void;
};

/** 「协作」分类：两份白名单写入 `delegation`（docs/design/agent-delegation-config-ui.md）。 */
export function DelegationFields(props: DelegationFieldsProps) {
  const { errors, disabled, selfName, onChange } = props;
  const topError = errors.find((error) => error.path === 'delegation' || /^delegation\.(?!agents\b|remoteAgents\b)/.test(error.path));
  return (
    <>
      <p className={s.hint}>这个智能体可以把自包含的子任务交给下列对象。不勾选 = 不能委派。描述会出现在模型的系统提示里。</p>
      {topError ? <small className={s.fieldError}>{topError.message}</small> : null}
      <div className={s.mcpList}>
        <DelegationGroup
          title="同组织智能体"
          field="agents"
          selected={props.agents}
          candidates={props.localCandidates}
          max={props.maxAgents}
          selfName={selfName}
          errors={errors}
          disabled={disabled}
          empty="组织内没有其他智能体。"
          footer="子任务以同一用户身份运行，使用目标智能体自己的模型、工具权限和审批。"
          onChange={(next) => onChange('agents', next)}
        />
        <DelegationGroup
          title="远端智能体（A2A）"
          field="remoteAgents"
          selected={props.remoteAgents}
          candidates={props.remoteCandidates}
          max={props.maxRemoteAgents}
          selfName={selfName}
          errors={errors}
          disabled={disabled}
          badge="需审批"
          empty="运维尚未登记远端智能体（A2A_REMOTE_AGENTS_JSON）。"
          footer="每次调用都需要人工批准；只发送任务文字，不带附件、工作区文件或对话记录。远端清单由运维配置，这里只能选择。"
          onChange={(next) => onChange('remoteAgents', next)}
        />
      </div>
    </>
  );
}
