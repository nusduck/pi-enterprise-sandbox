import type { ConfigDiagnostic } from '../../shared/api/agents';
import {
  argumentValueFromInput,
  hostArgumentRows,
  type HostArgumentDecl,
} from './mcpArgumentHelpers';
import s from './agents.module.css';

type Props = {
  serverId: string;
  /** Index of this server's entry in the draft `mcpServers` array (for error paths). */
  entryIndex: number;
  declared: HostArgumentDecl[];
  current: Record<string, unknown>;
  issue: string | null;
  errors: ConfigDiagnostic[];
  disabled?: boolean;
  onChange: (name: string, value: string | number | boolean | undefined) => void;
};

/**
 * 「平台参数」：运维在 MCP_SERVERS_JSON 声明、由本智能体填值、模型看不到的工具参数
 * （docs/design/mcp-per-agent-arguments.md §5）。
 */
export function McpArgumentFields({ serverId, entryIndex, declared, current, issue, errors, disabled, onChange }: Props) {
  const rows = hostArgumentRows(declared, current);
  if (!rows.length && !issue) return null;
  const base = `mcpServers[${entryIndex}].toolArguments`;
  const errorAt = (path: string) => errors.find((error) => error.path === path)?.message ?? null;
  return (
    <div className={s.hostArgs}>
      <b>平台参数</b>
      <small className={s.hint}>模型看不到这些参数，调用时由平台填入；工具要求而留空时，该工具在对话中不可用。不要填写密钥。</small>
      {issue ? <p className={s.warnBox} role="status">{issue}，请在「JSON」里修正。</p> : null}
      {rows.map((row) => {
        const error = errorAt(`${base}.${row.name}`);
        return (
          <label key={row.name} className={`${s.hostArgRow}${row.stale ? ` ${s.permStale}` : ''}`}>
            <span>{row.description || row.name}</span>
            <code>{row.name}</code>
            <input
              value={row.value}
              disabled={disabled || Boolean(issue) || row.stale}
              aria-label={`${serverId} 平台参数 ${row.name}`}
              placeholder="留空 = 不填"
              onChange={(event) => onChange(row.name, argumentValueFromInput(event.target.value, current[row.name]))}
            />
            {row.stale ? (
              <button type="button" className={s.linkBtn} disabled={disabled} onClick={() => onChange(row.name, undefined)}>
                移除
              </button>
            ) : null}
            {row.stale ? <span className={s.tag}>已保留 · 当前部署未声明</span> : null}
            {error ? <small className={`${s.fieldError} ${s.hostArgError}`}>{error}</small> : null}
          </label>
        );
      })}
      {errorAt(base) ? <small className={s.fieldError}>{errorAt(base)}</small> : null}
    </div>
  );
}
