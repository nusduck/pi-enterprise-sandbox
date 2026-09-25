import type { AgentConfigValidationState } from './agentHelpers';
import { normalizedConfigChanged, parseAgentConfigDraft, warningMessage } from './agentHelpers';
import s from './agents.module.css';

function json(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** One-line validation status for the editor's top bar. */
export function validationSummary(state: AgentConfigValidationState): [string, string] {
  if (state.status === 'pending') return ['校验中…', s.stMute];
  if (state.status === 'valid') return ['校验通过', s.stOk];
  if (state.status === 'invalid') return [`${state.errors.length || 1} 处问题`, s.stErr];
  if (state.status === 'unavailable') return ['无法校验', s.stWarn];
  return ['', ''];
}

export function AgentValidationPanel({
  state,
  draft,
}: {
  state: AgentConfigValidationState;
  draft: string;
}) {
  const parsed = parseAgentConfigDraft(draft);
  const hasNormalizationDiff = parsed.ok && normalizedConfigChanged(parsed.config, state.normalizedConfig);
  const empty = state.status !== 'unavailable' && !state.errors.length && !state.warnings.length
    && !hasNormalizationDiff && state.effectiveSummary === undefined;
  if (empty) return null;
  return (
    <div className={s.validation} aria-live="polite">
      {state.status === 'unavailable' ? (
        <p className={s.warnBox} role="status">无法校验{state.message ? `：${state.message}` : ''}。在校验通过前不能发布。</p>
      ) : null}
      {state.errors.length ? (
        <div className={s.errBox} role="alert">
          <b>发布前需要修正 {state.errors.length} 处：</b>
          <ul>{state.errors.map((error) => <li key={`${error.path}:${error.code}`}><code>{error.path || '<根>'}</code> — {error.message}</li>)}</ul>
        </div>
      ) : null}
      {state.warnings.length ? (
        <div className={s.warnBox}>
          <b>请留意</b>
          <ul>{state.warnings.map((warning, index) => <li key={`${warningMessage(warning)}:${index}`}>{warningMessage(warning)}</li>)}</ul>
        </div>
      ) : null}
      {hasNormalizationDiff ? (
        <details className={s.details}>
          <summary>服务端会规范化这份草稿</summary>
          <p className={s.hint}>保存的是规范化后的形式。发布前请核对差异；编辑器保留你的原始草稿。</p>
          <div className={s.diff}>
            <div><span>草稿</span><pre>{json(parsed.ok ? parsed.config : draft)}</pre></div>
            <div><span>规范化后</span><pre>{json(state.normalizedConfig)}</pre></div>
          </div>
        </details>
      ) : null}
      {state.effectiveSummary !== undefined ? (
        <details className={s.details}>
          <summary>生效配置摘要</summary>
          <p className={s.hint}>这是服务端在当前平台约束下的投影，不是完整的模型上下文。</p>
          <pre>{json(state.effectiveSummary)}</pre>
        </details>
      ) : null}
    </div>
  );
}
