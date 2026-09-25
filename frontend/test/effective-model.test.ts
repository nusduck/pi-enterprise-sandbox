import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveModel, supportsImages } from '../src/features/chat/effectiveModel.ts';

// Catalog shape as served by /api/capabilities/models.
const models = [
  { model_id: 'deepseek-flash', name: 'DeepSeek Flash', input_modalities: ['text', 'image'], default: true },
  { model_id: 'qwen3.8-27b', name: 'Qwen 3.8 27B', input_modalities: ['text'], default: false },
];

describe('effectiveModel', () => {
  it('falls back to the catalog default when nothing is selected', () => {
    // Treating "no selection" as "no model" blocked image sends even though
    // the server default reads images.
    const m = effectiveModel(models, null);
    assert.equal(m?.model_id, 'deepseek-flash');
    assert.equal(supportsImages(m), true);
  });

  it('prefers the pinned model, then the user pick', () => {
    assert.equal(effectiveModel(models, 'qwen3.8-27b')?.model_id, 'qwen3.8-27b');
    assert.equal(effectiveModel(models, 'qwen3.8-27b', 'deepseek-flash')?.model_id, 'deepseek-flash');
    assert.equal(supportsImages(effectiveModel(models, 'qwen3.8-27b')), false);
  });

  it('returns null when the catalog marks no default', () => {
    assert.equal(effectiveModel(models.map((m) => ({ ...m, default: false })), null), null);
  });
});
