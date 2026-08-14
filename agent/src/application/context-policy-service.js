/**
 * Apply the immutable Agent Profile compaction policy to one Run's settings.
 *
 * Uses `SettingsManager.applyOverrides` — the SDK's own "layer values on top of
 * the loaded settings" entry point. It merges into the manager's in-memory view
 * only: `globalSettings`/`projectSettings` are untouched and no field is marked
 * modified, so nothing is queued for write-back to the settings file that every
 * tenant's Run shares.
 *
 * The policy is applied in full every time, including its defaults, rather than
 * only the fields an AgentVersion names. A Run's compaction behaviour must be a
 * function of its AgentVersion, not of whatever settings.json happens to sit in
 * the container image or the agent home directory.
 */

/** Mirrors the SDK's DEFAULT_COMPACTION_SETTINGS; overridable for injection. */
export const FALLBACK_COMPACTION_DEFAULTS = Object.freeze({
  enabled: true,
  reserveTokens: 16_384,
  keepRecentTokens: 20_000,
});

/**
 * @param {{ applyOverrides?: Function }} settingsManager
 * @param {{ autoCompact?: boolean, reserveTokens?: number, keepRecentTokens?: number }} [policy]
 * @param {{ defaults?: { enabled?: boolean, reserveTokens?: number, keepRecentTokens?: number } }} [opts]
 *   `defaults` should be the SDK's `DEFAULT_COMPACTION_SETTINGS` so an absent
 *   policy tracks the SDK rather than a copied constant.
 */
export function applyContextPolicy(settingsManager, policy = {}, opts = {}) {
  if (!settingsManager) throw new Error('settingsManager is required');
  if (typeof settingsManager.applyOverrides !== 'function') {
    throw new Error(
      'settingsManager.applyOverrides is required to apply the compaction policy ' +
        '(SDK SettingsManager API changed)',
    );
  }

  const defaults = { ...FALLBACK_COMPACTION_DEFAULTS, ...(opts.defaults ?? {}) };
  const compaction = {
    enabled: policy.autoCompact !== false,
    reserveTokens: Number(policy.reserveTokens ?? defaults.reserveTokens),
    keepRecentTokens: Number(policy.keepRecentTokens ?? defaults.keepRecentTokens),
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

  settingsManager.applyOverrides({ compaction });
  return settingsManager;
}
