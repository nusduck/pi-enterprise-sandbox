/**
 * Compact budget usage bar — shown when backend provides usage (F4).
 */
import {
  budgetTone,
  extractBudgetSnapshot,
  formatBudgetSummary,
  hasBudgetData,
  listBudgetDimensions,
  type BudgetSnapshot,
} from './budget';
import type { RunEntity } from '../../entities';

export function BudgetBar({
  run,
  snapshot,
}: {
  run?: RunEntity | null;
  snapshot?: BudgetSnapshot | null;
}) {
  const snap =
    snapshot ||
    (run
      ? extractBudgetSnapshot({
          budgetUsage: run.budgetUsage,
          budgetLimits: run.budgetLimits,
          budgetWarning: run.budgetWarning,
        })
      : null);

  if (!hasBudgetData(snap) || !snap) return null;

  const tone = budgetTone(snap);
  const summary = formatBudgetSummary(snap);
  const dims = listBudgetDimensions(snap);
  const primary = dims.find((d) => d.ratio != null) || dims[0];
  const pct =
    primary?.ratio != null
      ? Math.min(100, Math.round(primary.ratio * 100))
      : 0;

  return (
    <div
      className={`budget-bar tone-${tone}`}
      role="status"
      aria-label={`Budget: ${summary}`}
      title={summary}
    >
      <span className="bb-label">Budget</span>
      <div className="bb-track" aria-hidden="true">
        <div className="bb-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="bb-summary mono">{summary}</span>
      {snap.warning === 'warning' ? (
        <span className="bb-warn">near limit</span>
      ) : null}
      {snap.warning === 'exceeded' || tone === 'exceeded' ? (
        <span className="bb-warn">exceeded</span>
      ) : null}
    </div>
  );
}
