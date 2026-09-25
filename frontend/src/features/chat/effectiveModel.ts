/**
 * Which model will actually serve the next turn, as far as the client can
 * tell: one pinned by the conversation's AgentVersion, else the user's pick,
 * else the catalog entry the server marks `default`. Returning null means the
 * catalog does not say (the server still decides).
 */
import type { ModelItem } from '../../shared/api';

function idOf(model: ModelItem): string {
  return String(model.model_id || model.id || '');
}

export function effectiveModel(
  models: readonly ModelItem[],
  selectedModelId: string | null,
  fixedModelId: string | null = null,
): ModelItem | null {
  for (const id of [fixedModelId, selectedModelId]) {
    if (!id) continue;
    const hit = models.find((m) => idOf(m) === id);
    if (hit) return hit;
  }
  return models.find((m) => m.default === true) ?? null;
}

export function supportsImages(model: ModelItem | null): boolean {
  return Array.isArray(model?.input_modalities) && model.input_modalities.map(String).includes('image');
}
