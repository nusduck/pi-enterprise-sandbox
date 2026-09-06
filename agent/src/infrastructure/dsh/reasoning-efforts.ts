/**
 * Reasoning-effort ids the **currently routed DSH adapter** accepts.
 *
 * Why this file exists: the model registry inherited a pi-ai thinking-level
 * enum (`off|minimal|low|medium|high|xhigh`) that no longer describes the wire.
 * Under DSH the effort travels on `ModelSelection.reasoningEffort` and is
 * interpreted by the provider adapter, and `@deepseek-ai/dsh-llm-deepseek`
 * accepts exactly `off | low | high | max`. Offering an admin `medium` and
 * quietly sending something else is the "guessed mapping" the AgentVersion
 * integration plan (§3, §4.3) rules out, so the catalog projection and the
 * factory both read the effort list from here.
 *
 * Unknown routes get an empty list: no effort is selectable until someone
 * states what that adapter supports (fail-closed, AGENTS.md §2).
 */

/**
 * Mirrors `Config.reasoningEffort` in `@deepseek-ai/dsh-llm-deepseek`.
 * `off` disables thinking for the request; the rest are effort levels.
 */
export const DEEPSEEK_REASONING_EFFORTS: readonly string[] = Object.freeze([
  'off',
  'low',
  'high',
  'max',
]);

/** DSH provider route → the effort ids that route's adapter accepts. */
const EFFORTS_BY_ROUTE: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'deepseek-official': DEEPSEEK_REASONING_EFFORTS,
});

/**
 * Map a registry `provider` onto the DSH provider route.
 *
 * Kept next to the effort table so the two cannot drift: whoever adds a route
 * has to say what efforts it accepts in the same edit.
 */
export function dshProviderRoute(raw: unknown): string {
  const p = String(raw ?? '').trim();
  if (!p || p === 'llmio' || p === 'openai' || p === 'deepseek') return 'deepseek-official';
  return p;
}

/** Effort ids accepted by the adapter behind `providerRoute` ('' → none). */
export function reasoningEffortsForRoute(providerRoute: unknown): readonly string[] {
  return EFFORTS_BY_ROUTE[String(providerRoute ?? '').trim()] ?? Object.freeze([]);
}

/**
 * Effort ids an admin may choose for one registry entry.
 *
 * The entry's own `thinking_levels` allowlist can only *narrow* what the
 * adapter accepts — a registry file cannot invent an effort the wire rejects.
 * A non-reasoning model offers none.
 */
export function selectableReasoningEfforts(entry: {
  provider?: unknown;
  supports_reasoning?: unknown;
  thinking_levels?: readonly unknown[];
}): readonly string[] {
  if (!entry?.supports_reasoning) return [];
  const accepted = reasoningEffortsForRoute(dshProviderRoute(entry.provider));
  const declared = Array.isArray(entry.thinking_levels)
    ? new Set(entry.thinking_levels.map((level) => String(level).trim().toLowerCase()))
    : null;
  if (!declared || declared.size === 0) return accepted;
  return Object.freeze(accepted.filter((effort) => declared.has(effort)));
}
