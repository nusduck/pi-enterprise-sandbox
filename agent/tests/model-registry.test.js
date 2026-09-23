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
  toRuntimeModel,
} from '../src/infrastructure/model-registry.js';

/**
 * Fixture catalog for the registry-mechanism tests.
 *
 * Deliberately not SEED_MODELS: these tests are about the registry being
 * data-driven — different entries must yield different resolved values rather
 * than a hard-coded constant — and pinning that to whichever models happen to
 * ship makes editing the catalog break unrelated tests. The shipped seed is
 * covered separately below.
 */
const FIXTURE_MODELS = Object.freeze([
  {
    provider: 'llmio',
    model_id: 'fixture-plain',
    name: 'Fixture Plain',
    api_protocol: 'openai-completions',
    input_modalities: ['text'],
    context_window: 262144,
    max_output_tokens: 65536,
    supports_tool_call: true,
    supports_developer_role: false,
    supports_reasoning: false,
    thinking_levels: [],
    default: true,
    pricing: { input_per_mtok: 0.14, output_per_mtok: 0.28 },
    enabled: true,
  },
  {
    provider: 'llmio',
    model_id: 'fixture-wide',
    name: 'Fixture Wide Context',
    api_protocol: 'openai-completions',
    input_modalities: ['text'],
    context_window: 1048576,
    max_output_tokens: 65536,
    supports_tool_call: true,
    supports_developer_role: false,
    supports_reasoning: false,
    thinking_levels: [],
    pricing: { input_per_mtok: 0.15, output_per_mtok: 0.6 },
    enabled: true,
  },
  {
    provider: 'llmio',
    model_id: 'fixture-reasoning',
    name: 'Fixture Reasoning',
    api_protocol: 'openai-completions',
    input_modalities: ['text', 'image'],
    context_window: 262144,
    max_output_tokens: 65536,
    supports_tool_call: true,
    supports_developer_role: true,
    supports_reasoning: true,
    thinking_levels: ['minimal', 'low', 'medium', 'high'],
    pricing: { input_per_mtok: 2.5, output_per_mtok: 10.0 },
    enabled: true,
  },
  {
    provider: 'llmio',
    model_id: 'fixture-disabled',
    name: 'Fixture Disabled',
    api_protocol: 'openai-completions',
    input_modalities: ['text'],
    context_window: 8000,
    max_output_tokens: 1024,
    supports_tool_call: false,
    supports_developer_role: false,
    supports_reasoning: false,
    thinking_levels: [],
    pricing: {},
    enabled: false,
  },
]);

/** @param {string} id */
function fixtureModel(id) {
  return resolveModel(id, {
    registry: buildRegistry({ seed: FIXTURE_MODELS, filePath: null }),
    applyOverrides: false,
  });
}

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

  it('maps camelCase id/contextWindow/maxTokens aliases', () => {
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
    const plain = fixtureModel('fixture-plain');
    const wide = fixtureModel('fixture-wide');
    const reasoning = fixtureModel('fixture-reasoning');

    assert.equal(plain.context_window, 262144);
    assert.equal(plain.max_output_tokens, 65536);
    assert.equal(wide.context_window, 1048576);
    assert.equal(reasoning.max_output_tokens, 65536);
    assert.notEqual(plain.context_window, wide.context_window);
  });

  it('registry marks tool calling and reasoning capability', () => {
    const plain = fixtureModel('fixture-plain');
    const reasoning = fixtureModel('fixture-reasoning');

    assert.equal(plain.supports_tool_call, true);
    assert.equal(plain.supports_reasoning, false);
    assert.deepEqual(plain.thinking_levels, []);
    assert.equal(plain.supports_developer_role, false);

    assert.equal(reasoning.supports_reasoning, true);
    assert.ok(reasoning.thinking_levels.includes('high'));
    assert.equal(reasoning.supports_developer_role, true);
  });

  it('toRuntimeModel maps registry capabilities into session model object', () => {
    const gpt = fixtureModel('fixture-reasoning');
    const model = toRuntimeModel(gpt, { baseUrl: 'https://llm.example', apiKey: 'k' });

    assert.equal(model.id, 'fixture-reasoning');
    assert.equal(model.contextWindow, 262144);
    assert.equal(model.maxTokens, 65536);
    assert.equal(model.compat.supportsDeveloperRole, true);
    assert.equal(model.cost.input, gpt.pricing.input_per_mtok);
    assert.equal(model.baseUrl, 'https://llm.example');
    assert.equal(model.headers, undefined);
    // Required descriptor field reasoning, from supports_reasoning
    assert.equal(model.reasoning, true);
    // Must not set image-model-only `output`
    assert.equal('output' in model, false);
  });

  it('toRuntimeModel uses registry values — not a single hard-coded context/max', () => {
    // The wide-context entry keeps its context while sharing the output cap.
    const gemini = fixtureModel('fixture-wide');
    const gpt = fixtureModel('fixture-reasoning');
    const modelGemini = toRuntimeModel(gemini, { baseUrl: 'http://x' });
    const modelGpt = toRuntimeModel(gpt, { baseUrl: 'http://x' });
    assert.equal(modelGemini.contextWindow, 1048576);
    assert.equal(modelGpt.maxTokens, 65536);
    assert.notEqual(modelGemini.contextWindow, modelGpt.contextWindow);
    assert.equal(modelGemini.maxTokens, modelGpt.maxTokens);
    assert.equal(modelGemini.reasoning, false);
    assert.equal(modelGpt.reasoning, true);
  });

  it('toRuntimeModel carries every field assertModelShape requires', () => {
    const flash = fixtureModel('fixture-plain');
    const model = toRuntimeModel(flash, { baseUrl: 'http://x' });
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
      assert.ok(field in model, `missing ${field}`);
    }
    assert.equal(typeof model.reasoning, 'boolean');
    assert.equal(Array.isArray(model.input), true);
    assert.equal(typeof model.cost.input, 'number');
  });
});

describe('disabled model', () => {
  it('rejects disabled models on resolve', () => {
    const reg = buildRegistry({ seed: FIXTURE_MODELS, filePath: null });
    assert.throws(
      () => resolveModel('fixture-disabled', { registry: reg }),
      (err) => {
        assert.ok(err instanceof ModelRegistryError);
        assert.equal(err.code, 'model_disabled');
        assert.equal(err.modelId, 'fixture-disabled');
        return true;
      },
    );
  });

  it('rejects unknown models fail-closed', () => {
    const reg = buildRegistry({ seed: FIXTURE_MODELS, filePath: null });
    assert.throws(
      () => resolveModel('totally-unknown-model-xyz', { registry: reg }),
      (err) => err instanceof ModelRegistryError && err.code === 'model_not_found',
    );
  });

  it('allowDisabled returns the entry for admin inspection', () => {
    const reg = buildRegistry({ seed: FIXTURE_MODELS, filePath: null });
    const e = resolveModel('fixture-disabled', {
      registry: reg,
      allowDisabled: true,
      applyOverrides: false,
    });
    assert.equal(e.enabled, false);
    assert.equal(e.context_window, 8000);
  });

  it('listEnabledModels excludes disabled', () => {
    const reg = buildRegistry({ seed: FIXTURE_MODELS, filePath: null });
    const enabled = listEnabledModels(reg);
    assert.ok(enabled.every((m) => m.enabled));
    assert.ok(!enabled.some((m) => m.model_id === 'fixture-disabled'));
  });

  it('the shipped seed offers no disabled entry', () => {
    // A "test model" used to ride along in the production seed; the fixtures
    // above own that case now, so the shipped catalog is all real models.
    assert.deepEqual(
      SEED_MODELS.filter((m) => m.enabled === false),
      [],
    );
  });

  it('the shipped seed is exactly the live LLMIO catalog', () => {
    assert.deepEqual(
      SEED_MODELS.map((m) => m.model_id),
      ['deepseek-flash', 'qwen3.8-27b'],
    );
    assert.deepEqual(
      [...SEED_MODELS.find((m) => m.model_id === 'deepseek-flash').input_modalities],
      ['text', 'image'],
    );
    assert.deepEqual(
      [...SEED_MODELS.find((m) => m.model_id === 'qwen3.8-27b').input_modalities],
      ['text'],
    );
  });
});

describe('usage recording', () => {


});

describe('env overrides (backward compatible)', () => {
  it('MODEL_CONTEXT_WINDOW / MODEL_MAX_TOKENS override active model only', () => {
    const reg = buildRegistry({ seed: SEED_MODELS, filePath: null });
    const base = resolveModel('deepseek-flash', {
      registry: reg,
      applyOverrides: false,
    });
    const overridden = applyEnvOverrides(base, {
      MODEL_ID: 'deepseek-flash',
      MODEL_CONTEXT_WINDOW: '64000',
      MODEL_MAX_TOKENS: '4096',
    });
    assert.equal(overridden.context_window, 64000);
    assert.equal(overridden.max_output_tokens, 4096);

    // Overrides for a different MODEL_ID do not apply.
    const other = applyEnvOverrides(
      resolveModel('qwen3.8-27b', { registry: reg, applyOverrides: false }),
      {
        MODEL_ID: 'deepseek-flash',
        MODEL_CONTEXT_WINDOW: '1',
        MODEL_MAX_TOKENS: '1',
      },
    );
    assert.equal(other.context_window, 262144);
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

describe('model registry carries pricing, not cost arithmetic', () => {
  it('registry pricing reaches the Model descriptor', () => {
    // The registry used to run its own cost arithmetic on these numbers; that
    // duplicate is gone. This pins the one projection that remains:
    // catalog pricing -> Model.cost.
    const entry = resolveModel('deepseek-flash', { env: {} });
    const model = toRuntimeModel(entry, { baseUrl: 'http://localhost' });
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
        `${gone} was a duplicate cost engine — do not reintroduce it`,
      );
    }
  });
});
