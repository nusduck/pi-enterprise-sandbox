/**
 * Build the SettingsManager one Run executes against, with the immutable Agent
 * Profile compaction policy already in it.
 *
 * Two constraints shape this:
 *
 *  1. The policy must hold for the whole Run. `applyOverrides` looked like the
 *     supported seam, but it only writes `SettingsManager.settings`, and
 *     `save()` — reached from `setModel`, `setThinkingLevel`,
 *     `setAutoCompactionEnabled`, `setSteeringMode`, … — begins by rebuilding
 *     `settings` from `globalSettings`/`projectSettings`, silently discarding
 *     it. The policy therefore has to live in `globalSettings`, which is what
 *     `SettingsManager.inMemory(seed)` does.
 *
 *  2. Nothing may be written back. The settings file is shared by every
 *     tenant's Runs, so a per-AgentVersion value must never reach it.
 *     `inMemory` uses `InMemorySettingsStorage`, so `save()` is a no-op on disk.
 *
 * Operator settings still apply: the on-disk manager is read first and its
 * effective values seed the in-memory one. Only `compaction` is replaced, and
 * it is replaced in full — including its defaults — because a Run's compaction
 * behaviour must be a function of its AgentVersion, not of whatever
 * settings.json happens to sit in the image or the agent home directory.
 */

/** Mirrors the SDK's DEFAULT_COMPACTION_SETTINGS; overridable for injection. */
export const FALLBACK_COMPACTION_DEFAULTS = Object.freeze({
  enabled: true,
  reserveTokens: 16_384,
  keepRecentTokens: 20_000,
});

/**
 * @param {{ autoCompact?: boolean, reserveTokens?: number, keepRecentTokens?: number }} [policy]
 * @param {{ enabled?: boolean, reserveTokens?: number, keepRecentTokens?: number }} [defaults]
 *   Pass the SDK's `DEFAULT_COMPACTION_SETTINGS` so an absent policy tracks the
 *   SDK rather than a copied constant.
 * @returns {{ enabled: boolean, reserveTokens: number, keepRecentTokens: number }}
 */
export function resolveCompactionSettings(policy = {}, defaults = {}) {
  const base = { ...FALLBACK_COMPACTION_DEFAULTS, ...defaults };
  const compaction = {
    enabled: policy.autoCompact !== false,
    reserveTokens: Number(policy.reserveTokens ?? base.reserveTokens),
    keepRecentTokens: Number(policy.keepRecentTokens ?? base.keepRecentTokens),
  };
  if (!Number.isFinite(compaction.reserveTokens) || compaction.reserveTokens < 0) {
    throw new Error('contextPolicy.reserveTokens must be a non-negative number');
  }
  if (
    !Number.isFinite(compaction.keepRecentTokens) ||
    compaction.keepRecentTokens < 0
  ) {
    throw new Error('contextPolicy.keepRecentTokens must be a non-negative number');
  }
  return compaction;
}

/**
 * @param {{
 *   create: (cwd: string, agentDir?: string) => object,
 *   inMemory: (settings?: object) => object,
 * }} SettingsManager  the SDK class
 * @param {{
 *   cwd: string,
 *   agentDir?: string,
 *   policy?: object,
 *   defaults?: object,
 * }} input
 */
export function createRunSettingsManager(SettingsManager, input) {
  if (
    typeof SettingsManager?.create !== 'function' ||
    typeof SettingsManager?.inMemory !== 'function'
  ) {
    throw new Error(
      'SettingsManager.create / .inMemory are required to build a Run settings manager ' +
        '(SDK SettingsManager API changed)',
    );
  }
  if (!input?.cwd) throw new Error('cwd is required');

  // Read whatever the operator configured. Missing files are not an error —
  // the SDK records a diagnostic and returns empty settings.
  const onDisk = SettingsManager.create(input.cwd, input.agentDir);
  const seed = {
    ...onDisk.getGlobalSettings(),
    ...onDisk.getProjectSettings(),
    compaction: resolveCompactionSettings(input.policy, input.defaults),
  };
  return SettingsManager.inMemory(seed);
}
