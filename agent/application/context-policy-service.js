/** Apply immutable Agent Profile compaction policy without mutating user settings files. */
export function applyContextPolicy(settingsManager, policy = {}) {
  if (!settingsManager) throw new Error('settingsManager is required');
  const enabled = policy.autoCompact !== false;
  const reserveTokens = Number(policy.reserveTokens ?? 16_384);
  const keepRecentTokens = Number(policy.keepRecentTokens ?? 20_000);
  settingsManager.getCompactionEnabled = () => enabled;
  settingsManager.getCompactionReserveTokens = () => reserveTokens;
  settingsManager.getCompactionKeepRecentTokens = () => keepRecentTokens;
  settingsManager.getCompactionSettings = () => ({
    enabled,
    reserveTokens,
    keepRecentTokens,
  });
  return settingsManager;
}
