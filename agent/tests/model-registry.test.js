/**
 * B7 Model Registry — capability switch, disabled model, usage/cost recording.
 * Run: node --test agent/tests/model-registry.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ModelRegistryError,
  SEED_MODELS,
  applyEnvOverrides,
  buildRegistry,
  listEnabledModels,
  loadModelsFromFile,
  normalizeModelEntry,
  resolveModel,
  toPiModel,
} from '../src/infrastructure/model-registry.js';

describe('normalizeModelEntry', () => {
  it('accepts full ADR field set', () => {
    const e = normalizeModelEntry({
      provider: 'llmio',
      model_id: 'x',
      api_protocol: 'openai-completions',
      input_modalities: ['text', 'image'],
      context_window: 1000,
      max_output_tokens: 200,
      supports_tool_call: true,
      supports_developer_role: true,
      supports_reasoning: true,
      thinking_levels: ['low', 'high'],
      pricing: { input_per_mtok: 1, output_per_mtok: 2 },
      enabled: true,
    });
    assert.equal(e.model_id, 'x');
    assert.equal(e.context_window, 1000);
    assert.equal(e.max_output_tokens, 200);
    assert.equal(e.supports_tool_call, true);
    assert.equal(e.supports_developer_role, true);
    assert.equal(e.supports_reasoning, true);
    assert.deepEqual(e.thinking_levels, ['low', 'high']);
    assert.equal(e.pricing.input_per_mtok, 1);
  });

  it('maps pi-style id/contextWindow/maxTokens aliases', () => {
    const e = normalizeModelEntry({
      id: 'alias-model',
      contextWindow: 9999,
      maxTokens: 111,
      input: ['text'],
    });
    assert.equal(e.model_id, 'alias-model');
    assert.equal(e.context_window, 9999);
    assert.equal(e.max_output_tokens, 111);
  });
});

describe('capability switch', () => {
  it('enforces a 256 Ki-token platform floor while preserving larger contexts', () => {
    const flash = resolveModel('deepseek-v4-flash', {
      registry: buildRegistry({ seed: SEED_MODELS, filePath: null }),
      applyOverrides: false,
    });
    const gemini = resolveModel('gemini-3.5-flash', {
      registry: buildRegistry({ seed: SEED_MODELS, filePath: null }),
      applyOverrides: false,
    });
    const gpt = resolveModel('gpt-5.5', {
      registry: buildRegistry({ seed: SEED_MODELS, filePath: null }),
      applyOverrides: false,
    });

    assert.equal(flash.context_window, 262144);
    assert.equal(flash.max_output_tokens, 65536);
    assert.equal(gemini.context_window, 1048576);
    assert.equal(gpt.max_output_tokens, 65536);
    assert.notEqual(flash.context_window, gemini.context_window);
  });

  it('registry marks tool calling and reasoning capability', () => {
    const reg = buildRegistry({ seed: SEED_MODELS, filePath: null });
    const flash = resolveModel('deepseek-v4-flash', { registry: reg, applyOverrides: false });
    const pro = resolveModel('deepseek-v4-pro', { registry: reg, applyOverrides: false });
    const gpt = resolveModel('gpt-5.5', { registry: reg, applyOverrides: false });

    assert.equal(flash.supports_tool_call, true);
    assert.equal(flash.supports_reasoning, false);
    assert.deepEqual(flash.thinking_levels, []);

    assert.equal(pro.supports_reasoning, true);
    assert.ok(pro.thinking_levels.includes('high'));

    assert.equal(gpt.supports_developer_role, true);
    assert.equal(gpt.supports_reasoning, true);
  });

  it('toPiModel maps registry capabilities into session model object', () => {
    const reg = buildRegistry({ seed: SEED_MODELS, filePath: null });
    const gpt = resolveModel('gpt-5.5', { registry: reg, applyOverrides: false });
    const pi = toPiModel(gpt, { baseUrl: 'https://llm.example', apiKey: 'k' });

    assert.equal(pi.id, 'gpt-5.5');
    assert.equal(pi.contextWindow, 262144);
    assert.equal(pi.maxTokens, 65536);
    assert.equal(pi.compat.supportsDeveloperRole, true);
    assert.equal(pi.cost.input, gpt.pricing.input_per_mtok);
    assert.equal(pi.baseUrl, 'https://llm.example');
    assert.equal(pi.headers, undefined);
    // Required pi-ai Model.reasoning from supports_reasoning
    assert.equal(pi.reasoning, true);
    // Must not set ImagesModel-only `output`
    assert.equal('output' in pi, false);
  });

  it('toPiModel uses registry values — not a single hard-coded context/max', () => {
    // Gemini keeps its larger context while sharing the platform output cap.
    const reg = buildRegistry({ seed: SEED_MODELS, filePath: null });
    const gemini = resolveModel('gemini-3.5-flash', {
      registry: reg,
      applyOverrides: false,
    });
    const gpt = resolveModel('gpt-5.5', { registry: reg, applyOverrides: false });
    const piGemini = toPiModel(gemini, { baseUrl: 'http://x' });
    const piGpt = toPiModel(gpt, { baseUrl: 'http://x' });
    assert.equal(piGemini.contextWindow, 1048576);
    assert.equal(piGpt.maxTokens, 65536);
    assert.notEqual(piGemini.contextWindow, piGpt.contextWindow);
    assert.equal(piGemini.maxTokens, piGpt.maxTokens);
    assert.equal(piGemini.reasoning, false);
    assert.equal(piGpt.reasoning, true);
  });

  it('toPiModel required Model fields match pi-ai shape', () => {
    const reg = buildRegistry({ seed: SEED_MODELS, filePath: null });
    const flash = resolveModel('deepseek-v4-flash', {
      registry: reg,
      applyOverrides: false,
    });
    const pi = toPiModel(flash, { baseUrl: 'http://x' });
    for (const field of [
      'id',
      'name',
      'api',
      'provider',
      'baseUrl',
      'reasoning',
      'input',
      'cost',
      'contextWindow',
      'maxTokens',
    ]) {
      assert.ok(field in pi, `missing ${field}`);
    }
    assert.equal(typeof pi.reasoning, 'boolean');
    assert.equal(Array.isArray(pi.input), true);
    assert.equal(typeof pi.cost.input, 'number');
  });
});

describe('disabled model', () => {
  it('rejects disabled models on resolve', () => {
    const reg = buildRegistry({ seed: SEED_MODELS, filePath: null });
    assert.throws(
      () => resolveModel('disabled-test-model', { registry: reg }),
      (err) => {
        assert.ok(err instanceof ModelRegistryError);
        assert.equal(err.code, 'model_disabled');
        assert.equal(err.modelId, 'disabled-test-model');
        return true;
      },
    );
  });

  it('rejects unknown models fail-closed', () => {
    const reg = buildRegistry({ seed: SEED_MODELS, filePath: null });
    assert.throws(
      () => resolveModel('totally-unknown-model-xyz', { registry: reg }),
      (err) => err instanceof ModelRegistryError && err.code === 'model_not_found',
    );
  });

  it('allowDisabled returns the entry for admin inspection', () => {
    const reg = buildRegistry({ seed: SEED_MODELS, filePath: null });
    const e = resolveModel('disabled-test-model', {
      registry: reg,
      allowDisabled: true,
      applyOverrides: false,
    });
    assert.equal(e.enabled, false);
    assert.equal(e.context_window, 8000);
  });

  it('listEnabledModels excludes disabled', () => {
    const reg = buildRegistry({ seed: SEED_MODELS, filePath: null });
    const enabled = listEnabledModels(reg);
    assert.ok(enabled.every((m) => m.enabled));
    assert.ok(!enabled.some((m) => m.model_id === 'disabled-test-model'));
  });
});

describe('usage recording', () => {


});

describe('env overrides (backward compatible)', () => {
  it('MODEL_CONTEXT_WINDOW / MODEL_MAX_TOKENS override active model only', () => {
    const reg = buildRegistry({ seed: SEED_MODELS, filePath: null });
    const base = resolveModel('deepseek-v4-flash', {
      registry: reg,
      applyOverrides: false,
    });
    const overridden = applyEnvOverrides(base, {
      MODEL_ID: 'deepseek-v4-flash',
      MODEL_CONTEXT_WINDOW: '64000',
      MODEL_MAX_TOKENS: '4096',
    });
    assert.equal(overridden.context_window, 64000);
    assert.equal(overridden.max_output_tokens, 4096);

    // Overrides for a different MODEL_ID do not apply.
    const other = applyEnvOverrides(
      resolveModel('gemini-3.5-flash', { registry: reg, applyOverrides: false }),
      {
        MODEL_ID: 'deepseek-v4-flash',
        MODEL_CONTEXT_WINDOW: '1',
        MODEL_MAX_TOKENS: '1',
      },
    );
    assert.equal(other.context_window, 1048576);
  });
});

describe('file-backed registry', () => {
  it('loads enterprise JSON and overrides seed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'model-reg-'));
    try {
      const path = join(dir, 'registry.json');
      writeFileSync(
        path,
        JSON.stringify({
          models: [
            {
              provider: 'llmio',
              model_id: 'custom-model',
              api_protocol: 'openai-completions',
              context_window: 42,
              max_output_tokens: 7,
              supports_tool_call: true,
              supports_developer_role: false,
              supports_reasoning: false,
              thinking_levels: [],
              pricing: { input_per_mtok: 0, output_per_mtok: 0 },
              enabled: true,
            },
          ],
        }),
      );
      const models = loadModelsFromFile(path);
      assert.equal(models.length, 1);
      assert.equal(models[0].context_window, 42);

      const reg = buildRegistry({ seed: SEED_MODELS, filePath: path });
      const custom = resolveModel('custom-model', { registry: reg, applyOverrides: false });
      assert.equal(custom.max_output_tokens, 7);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('cost accounting is pi-ai’s job', () => {
  it('registry pricing reaches the pi-ai Model, which is what computes cost', () => {
    // pi-ai fills usage.cost from Model.cost on every assistant message
    // (pi-ai/dist/models.js). The registry used to run the same arithmetic on
    // the same numbers; that duplicate is gone, and this pins the one path
    // that remains: catalog pricing -> Model.cost -> pi-ai usage.cost.
    const entry = resolveModel('deepseek-v4-pro', { env: {} });
    const model = toPiModel(entry, { baseUrl: 'http://localhost' });
    assert.deepEqual(model.cost, {
      input: entry.pricing.input_per_mtok,
      output: entry.pricing.output_per_mtok,
      cacheRead: entry.pricing.cache_read_per_mtok,
      cacheWrite: entry.pricing.cache_write_per_mtok,
    });
  });

  it('exports no second cost engine', async () => {
    const mod = await import('../src/infrastructure/model-registry.js');
    for (const gone of [
      'estimateCost',
      'aggregateUsageFromMessages',
      'usageFromProviderResponse',
    ]) {
      assert.equal(
        mod[gone],
        undefined,
        `${gone} duplicates pi-ai cost accounting — do not reintroduce it`,
      );
    }
  });
});
