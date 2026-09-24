import type { AgentConfigValidationState } from './agentHelpers';
import { normalizedConfigChanged, parseAgentConfigDraft, warningMessage } from './agentHelpers';

function json(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
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
  return (
    <div className="agent-validation-panel" aria-live="polite">
      {state.status === 'pending' ? <p className="agent-validation-status pending">Checking this draft against the server…</p> : null}
      {state.status === 'unavailable' ? <p className="agent-validation-status unavailable" role="status">Validation is unavailable{state.message ? `: ${state.message}` : ''}. Publishing is blocked.</p> : null}
      {state.status === 'valid' ? <p className="agent-validation-status valid" role="status">Validated by the Agent service{state.capabilityRevision ? ` · capability revision ${state.capabilityRevision}` : ''}.</p> : null}
      {state.errors.length ? (
        <div className="agent-validation-errors" role="alert">
          <strong>Fix {state.errors.length} field{state.errors.length === 1 ? '' : 's'} before publishing.</strong>
          <ul>{state.errors.map((error) => <li key={`${error.path}:${error.code}`}><code>{error.path || '<root>'}</code> — {error.message}</li>)}</ul>
        </div>
      ) : null}
      {state.warnings.length ? (
        <div className="agent-validation-warnings">
          <strong>Review warnings</strong>
          <ul>{state.warnings.map((warning, index) => <li key={`${warningMessage(warning)}:${index}`}>{warningMessage(warning)}</li>)}</ul>
        </div>
      ) : null}
      {hasNormalizationDiff ? (
        <details className="agent-normalization-diff" open>
          <summary>Server normalization changes this draft</summary>
          <p className="mgmt-hint">The server will persist the normalized form. Review the semantic difference before publishing; the editor keeps your original draft until you choose to apply it.</p>
          <div className="agent-diff-grid">
            <div><span>Draft</span><pre>{json(parsed.ok ? parsed.config : draft)}</pre></div>
            <div><span>Normalized</span><pre>{json(state.normalizedConfig)}</pre></div>
          </div>
        </details>
      ) : null}
      {state.effectiveSummary !== undefined ? (
        <details className="agent-effective-summary">
          <summary>Effective configuration summary</summary>
          <p className="mgmt-hint">This is a server projection under current platform constraints, not a complete future model context.</p>
          <pre>{json(state.effectiveSummary)}</pre>
        </details>
      ) : null}
    </div>
  );
}

