/**
 * B7 Model Registry — capability switch, disabled model, usage/cost recording.
 * Run: node --test agent/tests/model-registry.test.js
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ModelRegistryError,
  SEED_MODELS,
  aggregateUsageFromMessages,
  applyEnvOverrides,
  buildRegistry,
  estimateCost,
  listEnabledModels,
  loadModelsFromFile,
  normalizeModelEntry,
  resetDefaultRegistry,
  resolveModel,
  toPiModel,
  usageFromProviderResponse,
} from '../services/model-registry.js';

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
  beforeEach(() => {
    resetDefaultRegistry();
  });

  it('different models expose different context windows and max output', () => {
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

    assert.equal(flash.context_window, 128000);
    assert.equal(flash.max_output_tokens, 8192);
    assert.equal(gemini.context_window, 1048576);
    assert.equal(gpt.max_output_tokens, 16384);
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
    assert.equal(pi.contextWindow, 128000);
    assert.equal(pi.maxTokens, 16384);
    assert.equal(pi.compat.supportsDeveloperRole, true);
    assert.equal(pi.cost.input, gpt.pricing.input_per_mtok);
    assert.equal(pi.baseUrl, 'https://llm.example');
    assert.ok(pi.headers?.Authorization?.includes('k'));
  });

  it('toPiModel uses registry values — not a single hard-coded context/max', () => {
    // gemini has a non-default context window; gpt has a different max output.
    const reg = buildRegistry({ seed: SEED_MODELS, filePath: null });
    const gemini = resolveModel('gemini-3.5-flash', {
      registry: reg,
      applyOverrides: false,
    });
    const gpt = resolveModel('gpt-5.5', { registry: reg, applyOverrides: false });
    const piGemini = toPiModel(gemini, { baseUrl: 'http://x' });
    const piGpt = toPiModel(gpt, { baseUrl: 'http://x' });
    assert.equal(piGemini.contextWindow, 1048576);
    assert.equal(piGpt.maxTokens, 16384);
    assert.notEqual(piGemini.contextWindow, piGpt.contextWindow);
    assert.notEqual(piGemini.maxTokens, piGpt.maxTokens);
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
  it('estimateCost uses per-mtok pricing', () => {
    const cost = estimateCost(
      { input_per_mtok: 1, output_per_mtok: 2, cache_read_per_mtok: 0, cache_write_per_mtok: 0 },
      { input: 1_000_000, output: 500_000 },
    );
    assert.equal(cost.input, 1);
    assert.equal(cost.output, 1);
    assert.equal(cost.total, 2);
  });

  it('aggregateUsageFromMessages sums assistant usage and attaches model_id', () => {
    const reg = buildRegistry({ seed: SEED_MODELS, filePath: null });
    const entry = resolveModel('deepseek-v4-flash', {
      registry: reg,
      applyOverrides: false,
    });
    const usage = aggregateUsageFromMessages(
      [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 0 },
        },
        {
          role: 'assistant',
          usage: { input: 20, output: 30, cacheRead: 0, cacheWrite: 5 },
        },
      ],
      entry,
    );
    assert.equal(usage.input_tokens, 120);
    assert.equal(usage.output_tokens, 80);
    assert.equal(usage.cache_read_tokens, 10);
    assert.equal(usage.cache_write_tokens, 5);
    assert.equal(usage.total_tokens, 215);
    assert.equal(usage.model_id, 'deepseek-v4-flash');
    assert.equal(usage.provider, 'llmio');
    assert.ok(usage.cost.total > 0);
  });

  it('usageFromProviderResponse maps OpenAI-style usage', () => {
    const reg = buildRegistry({ seed: SEED_MODELS, filePath: null });
    const entry = resolveModel('gpt-5.5', { registry: reg, applyOverrides: false });
    const usage = usageFromProviderResponse(
      { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      entry,
    );
    assert.equal(usage.input_tokens, 10);
    assert.equal(usage.output_tokens, 5);
    assert.equal(usage.model_id, 'gpt-5.5');
    assert.ok(typeof usage.cost.total === 'number');
  });
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
