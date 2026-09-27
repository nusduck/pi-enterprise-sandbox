import type { ConfigDiagnostic } from '../../shared/api/agents';
import type { CatalogState } from './agentHelpers';
import { delegationRows, toggleDelegation, type DelegationCandidate } from './delegationHelpers';
import s from './agents.module.css';

export type DataSourceFieldsProps = {
  selected: string[];
  candidates: CatalogState<DelegationCandidate>;
  max: number;
  errors: ConfigDiagnostic[];
  disabled?: boolean;
  onChange: (next: string[]) => void;
};

function errorAt(errors: ConfigDiagnostic[], index: number): string | null {
  return errors.find((error) => error.path === `dataSources[${index}]` || error.path.startsWith(`dataSources[${index}].`))?.message ?? null;
}

/** 「数据源」分类：勾选写入 `dataSources`（docs/design/sandbox-data-sources.md §5）。 */
export function DataSourceFields({ selected, candidates, max, errors, disabled, onChange }: DataSourceFieldsProps) {
  // 目录不可用时，草稿里已有的条目都变成只能移除的「已保留」行。
  const rows = delegationRows(selected, candidates.available ? candidates.items : []);
  const full = selected.length >= max;
  const topError = errors.find((error) => error.path === 'dataSources')?.message ?? null;
  return (
    <>
      <p className={s.hint}>
        勾选后，这个智能体的每次运行都能在沙箱里连接这些业务库做数据分析。能使用这个智能体的人，都能让模型查询这些库。
        连接地址、账号和口令由运维配置，这里只能选择。
      </p>
      {topError ? <small className={s.fieldError}>{topError}</small> : null}
      <fieldset className={s.mcpCard}>
        <div className={s.mcpHead}>
          <b>业务数据库</b>
          <span className={s.sp} />
          <span className={s.tag}>已选 {selected.length} / {max}</span>
        </div>
        {candidates.loading ? <p className={s.hint}>正在读取…</p> : null}
        {!candidates.loading && !candidates.available ? (
          <p className={s.warnBox} role="status">
            数据源目录暂不可用{candidates.error ? `（${candidates.error}）` : ''}。草稿里已有的条目会保留，恢复前不能新增。
          </p>
        ) : null}
        <div className={s.delegList}>
          {rows.map((row) => {
            const canCheck = row.checked || (row.selectable && !full);
            const error = row.draftIndex >= 0 ? errorAt(errors, row.draftIndex) : null;
            const note = row.stale ? (candidates.available ? '当前部署未登记' : '目录暂不可用，只能移除') : row.note;
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
                <small className={s.delegDesc}>{row.stale ? '' : row.description}</small>
                {note ? <span className={s.tag}>{row.stale ? `已保留 · ${note}` : note}</span> : null}
                {error ? <small className={`${s.fieldError} ${s.delegError}`}>{error}</small> : null}
              </label>
            );
          })}
          {!rows.length && candidates.available ? (
            <p className={s.hint}>运维尚未登记数据源（SANDBOX_DATA_SOURCES_JSON）。</p>
          ) : null}
        </div>
        {full ? <p className={s.hint}>已达上限 {max}。</p> : null}
        <p className={s.hint}>
          模型在沙箱里通过环境变量 DSH_DB_&lt;ID&gt;_SOCKET / _USER / _PASSWORD / _DATABASE 连接；沙箱本身仍然没有网络。
        </p>
      </fieldset>
    </>
  );
}
