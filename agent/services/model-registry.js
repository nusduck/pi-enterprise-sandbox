/**
 * Enterprise Model Registry — capability source of truth for Agent sessions.
 *
 * Registry fields (ADR §4.10):
 *   provider, model_id, api_protocol, input_modalities, context_window,
 *   max_output_tokens, supports_tool_call, supports_developer_role,
 *   supports_reasoning, thinking_levels, pricing, enabled
 *
 * Config-backed with optional file seed. Env overrides (MODEL_ID,
 * MODEL_CONTEXT_WINDOW, MODEL_MAX_TOKENS) remain backward-compatible but are
 * no longer the sole source of capability constants on the hot path.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Default pricing when a model omits rates (cost reported as 0). */
export const ZERO_PRICING = Object.freeze({
  input_per_mtok: 0,
  output_per_mtok: 0,
  cache_read_per_mtok: 0,
  cache_write_per_mtok: 0,
});

/**
 * Built-in seed so the agent works without an external file mount.
 * Mirrors config/agent/model-registry.json.
 * @type {import('./model-registry.js').ModelEntry[]}
 */
export const SEED_MODELS = Object.freeze([
  {
    provider: 'llmio',
    model_id: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    api_protocol: 'openai-completions',
    input_modalities: Object.freeze(['text']),
    context_window: 128000,
    max_output_tokens: 8192,
    supports_tool_call: true,
    supports_developer_role: false,
    supports_reasoning: false,
    thinking_levels: Object.freeze([]),
    pricing: Object.freeze({
      input_per_mtok: 0.14,
      output_per_mtok: 0.28,
      cache_read_per_mtok: 0.014,
      cache_write_per_mtok: 0.14,
    }),
    enabled: true,
  },
  {
    provider: 'llmio',
    model_id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    api_protocol: 'openai-completions',
    input_modalities: Object.freeze(['text']),
    context_window: 128000,
    max_output_tokens: 8192,
    supports_tool_call: true,
    supports_developer_role: false,
    supports_reasoning: true,
    thinking_levels: Object.freeze(['low', 'medium', 'high']),
    pricing: Object.freeze({
      input_per_mtok: 1.25,
      output_per_mtok: 5.0,
      cache_read_per_mtok: 0.125,
      cache_write_per_mtok: 1.25,
    }),
    enabled: true,
  },
  {
    provider: 'llmio',
    model_id: 'gemini-3.5-flash',
    name: 'Gemini 3.5 Flash',
    api_protocol: 'openai-completions',
    // LLMIO gateway currently strips/ignores image_url for this model id.
    input_modalities: Object.freeze(['text']),
    context_window: 1048576,
    max_output_tokens: 8192,
    supports_tool_call: true,
    supports_developer_role: false,
    supports_reasoning: false,
    thinking_levels: Object.freeze([]),
    pricing: Object.freeze({
      input_per_mtok: 0.15,
      output_per_mtok: 0.6,
      cache_read_per_mtok: 0.0375,
      cache_write_per_mtok: 0.15,
    }),
    enabled: true,
  },
  {
    provider: 'llmio',
    model_id: 'gpt-5.5',
    name: 'GPT 5.5',
    api_protocol: 'openai-completions',
    input_modalities: Object.freeze(['text', 'image']),
    context_window: 128000,
    max_output_tokens: 16384,
    supports_tool_call: true,
    supports_developer_role: true,
    supports_reasoning: true,
    thinking_levels: Object.freeze(['minimal', 'low', 'medium', 'high']),
    pricing: Object.freeze({
      input_per_mtok: 2.5,
      output_per_mtok: 10.0,
      cache_read_per_mtok: 0.25,
      cache_write_per_mtok: 2.5,
    }),
    enabled: true,
  },
  {
    provider: 'llmio',
    model_id: 'mimo-v2.5',
    name: 'MiMo v2.5',
    api_protocol: 'openai-completions',
    // Verified vision via LLMIO OpenAI image_url (image_tokens in usage).
    input_modalities: Object.freeze(['text', 'image']),
    context_window: 128000,
    max_output_tokens: 8192,
    supports_tool_call: true,
    supports_developer_role: false,
    supports_reasoning: true,
    thinking_levels: Object.freeze([]),
    pricing: Object.freeze({
      input_per_mtok: 0.4,
      output_per_mtok: 1.2,
      cache_read_per_mtok: 0.04,
      cache_write_per_mtok: 0.4,
    }),
    enabled: true,
  },
  {
    provider: 'llmio',
    model_id: 'mimo-v2.5-pro',
    name: 'MiMo v2.5 Pro',
    api_protocol: 'openai-completions',
    input_modalities: Object.freeze(['text']),
    context_window: 128000,
    max_output_tokens: 8192,
    supports_tool_call: true,
    supports_developer_role: false,
    supports_reasoning: false,
    thinking_levels: Object.freeze([]),
    pricing: Object.freeze({
      input_per_mtok: 0.5,
      output_per_mtok: 1.5,
      cache_read_per_mtok: 0.05,
      cache_write_per_mtok: 0.5,
    }),
    enabled: true,
  },
  {
    provider: 'llmio',
    model_id: 'disabled-test-model',
    name: 'Disabled Test Model',
    api_protocol: 'openai-completions',
    input_modalities: Object.freeze(['text']),
    context_window: 8000,
    max_output_tokens: 1024,
    supports_tool_call: false,
    supports_developer_role: false,
    supports_reasoning: false,
    thinking_levels: Object.freeze([]),
    pricing: Object.freeze({ ...ZERO_PRICING }),
    enabled: false,
  },
]);

/**
 * @typedef {object} ModelPricing
 * @property {number} input_per_mtok
 * @property {number} output_per_mtok
 * @property {number} cache_read_per_mtok
 * @property {number} cache_write_per_mtok
 */

/**
 * @typedef {object} ModelEntry
 * @property {string} provider
 * @property {string} model_id
 * @property {string} [name]
 * @property {string} api_protocol
 * @property {string[]} input_modalities
 * @property {number} context_window
 * @property {number} max_output_tokens
 * @property {boolean} supports_tool_call
 * @property {boolean} supports_developer_role
 * @property {boolean} supports_reasoning
 * @property {string[]} thinking_levels
 * @property {ModelPricing} pricing
 * @property {boolean} enabled
 */

/**
 * @typedef {object} TokenUsage
 * @property {number} input_tokens
 * @property {number} output_tokens
 * @property {number} cache_read_tokens
 * @property {number} cache_write_tokens
 * @property {number} total_tokens
 * @property {{ input: number, output: number, cache_read: number, cache_write: number, total: number }} cost
 * @property {string} model_id
 * @property {string} provider
 */

export class ModelRegistryError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, modelId?: string|null }} [opts]
   */
  constructor(message, opts = {}) {
    super(message);
    this.name = 'ModelRegistryError';
    this.code = opts.code || 'model_registry_error';
    this.modelId = opts.modelId ?? null;
  }
}

/**
 * Normalize a raw registry object into a ModelEntry.
 * @param {Record<string, unknown>} raw
 * @returns {ModelEntry}
 */
export function normalizeModelEntry(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new ModelRegistryError('Invalid model entry', { code: 'invalid_entry' });
  }
  const modelId = String(raw.model_id || raw.id || '').trim();
  if (!modelId) {
    throw new ModelRegistryError('model_id is required', { code: 'missing_model_id' });
  }
  const pricingRaw =
    raw.pricing && typeof raw.pricing === 'object' ? raw.pricing : {};
  const pricing = {
    input_per_mtok: num(pricingRaw.input_per_mtok ?? pricingRaw.input, 0),
    output_per_mtok: num(pricingRaw.output_per_mtok ?? pricingRaw.output, 0),
    cache_read_per_mtok: num(
      pricingRaw.cache_read_per_mtok ?? pricingRaw.cacheRead,
      0,
    ),
    cache_write_per_mtok: num(
      pricingRaw.cache_write_per_mtok ?? pricingRaw.cacheWrite,
      0,
    ),
  };
  const modalities = Array.isArray(raw.input_modalities)
    ? raw.input_modalities.map(String)
    : Array.isArray(raw.input)
      ? raw.input.map(String)
      : ['text'];
  const thinking = Array.isArray(raw.thinking_levels)
    ? raw.thinking_levels.map(String)
    : [];

  return {
    provider: String(raw.provider || 'llmio'),
    model_id: modelId,
    name: raw.name != null ? String(raw.name) : modelId,
    api_protocol: String(
      raw.api_protocol || raw.api || 'openai-completions',
    ),
    input_modalities: modalities,
    context_window: Math.max(1, int(raw.context_window ?? raw.contextWindow, 128000)),
    max_output_tokens: Math.max(
      1,
      int(raw.max_output_tokens ?? raw.maxTokens, 8192),
    ),
    supports_tool_call: bool(raw.supports_tool_call, true),
    supports_developer_role: bool(raw.supports_developer_role, false),
    supports_reasoning: bool(raw.supports_reasoning, false),
    thinking_levels: thinking,
    pricing,
    enabled: bool(raw.enabled, true),
  };
}

/**
 * @param {unknown} v
 * @param {number} fallback
 */
function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * @param {unknown} v
 * @param {number} fallback
 */
function int(v, fallback) {
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * @param {unknown} v
 * @param {boolean} fallback
 */
function bool(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'no') return false;
  return fallback;
}

/**
 * Resolve path to the registry JSON file.
 * @param {NodeJS.ProcessEnv | Record<string, string|undefined>} [env]
 * @returns {string|null}
 */
export function resolveRegistryPath(env = process.env) {
  if (env.MODEL_REGISTRY_PATH && String(env.MODEL_REGISTRY_PATH).trim()) {
    return resolve(String(env.MODEL_REGISTRY_PATH).trim());
  }
  // Prefer repo config when running from source tree.
  const candidates = [
    join(__dirname, '../../config/agent/model-registry.json'),
    join(process.cwd(), 'config/agent/model-registry.json'),
    join(process.cwd(), '../config/agent/model-registry.json'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Load raw model list from a registry file.
 * Supports enterprise `{ models: [...] }` and pi-style `{ providers: { p: { models: [...] } } }`.
 * @param {string} filePath
 * @returns {ModelEntry[]}
 */
export function loadModelsFromFile(filePath) {
  const text = readFileSync(filePath, 'utf8');
  const data = JSON.parse(text);
  /** @type {Record<string, unknown>[]} */
  const raws = [];
  if (Array.isArray(data?.models)) {
    raws.push(...data.models);
  } else if (data?.providers && typeof data.providers === 'object') {
    for (const [provider, pcfg] of Object.entries(data.providers)) {
      const models = Array.isArray(pcfg?.models) ? pcfg.models : [];
      for (const m of models) {
        raws.push({
          provider: pcfg?.provider || provider,
          api_protocol: pcfg?.api || m.api,
          ...m,
          model_id: m.model_id || m.id,
          context_window: m.context_window ?? m.contextWindow,
          max_output_tokens: m.max_output_tokens ?? m.maxTokens,
        });
      }
    }
  } else if (Array.isArray(data)) {
    raws.push(...data);
  }
  return raws.map((r) => normalizeModelEntry(r));
}

/**
 * Build a registry map: model_id → ModelEntry (file overrides seed).
 * @param {{
 *   seed?: ModelEntry[],
 *   filePath?: string|null,
 *   env?: NodeJS.ProcessEnv | Record<string, string|undefined>,
 * }} [opts]
 * @returns {Map<string, ModelEntry>}
 */
export function buildRegistry(opts = {}) {
  const seed = opts.seed || SEED_MODELS;
  const map = new Map();
  for (const entry of seed) {
    map.set(entry.model_id, normalizeModelEntry(entry));
  }
  const filePath =
    opts.filePath !== undefined
      ? opts.filePath
      : resolveRegistryPath(opts.env || process.env);
  if (filePath && existsSync(filePath)) {
    try {
      for (const entry of loadModelsFromFile(filePath)) {
        map.set(entry.model_id, entry);
      }
    } catch (err) {
      console.warn(
        `[model-registry] Failed to load ${filePath}:`,
        err?.message || err,
      );
    }
  }
  return map;
}

/**
 * Apply backward-compatible env overrides onto a resolved entry.
 * MODEL_CONTEXT_WINDOW / MODEL_MAX_TOKENS only apply when they target the
 * active MODEL_ID (or when no model_id filter is set).
 *
 * @param {ModelEntry} entry
 * @param {NodeJS.ProcessEnv | Record<string, string|undefined>} [env]
 * @returns {ModelEntry}
 */
export function applyEnvOverrides(entry, env = process.env) {
  const next = { ...entry, pricing: { ...entry.pricing } };
  const envModelId = env.MODEL_ID != null ? String(env.MODEL_ID).trim() : '';
  // Env token limits apply to the default/active model only.
  const appliesToThis =
    !envModelId || envModelId === entry.model_id;

  if (appliesToThis) {
    if (env.MODEL_CONTEXT_WINDOW != null && String(env.MODEL_CONTEXT_WINDOW).trim() !== '') {
      const cw = parseInt(String(env.MODEL_CONTEXT_WINDOW), 10);
      if (Number.isFinite(cw) && cw > 0) next.context_window = cw;
    }
    if (env.MODEL_MAX_TOKENS != null && String(env.MODEL_MAX_TOKENS).trim() !== '') {
      const mt = parseInt(String(env.MODEL_MAX_TOKENS), 10);
      if (Number.isFinite(mt) && mt > 0) next.max_output_tokens = mt;
    }
  }
  return next;
}

/**
 * Resolve a model by id. Rejects missing and disabled models.
 *
 * @param {string|null|undefined} modelId
 * @param {{
 *   registry?: Map<string, ModelEntry>,
 *   env?: NodeJS.ProcessEnv | Record<string, string|undefined>,
 *   allowDisabled?: boolean,
 *   applyOverrides?: boolean,
 * }} [opts]
 * @returns {ModelEntry}
 */
export function resolveModel(modelId, opts = {}) {
  const env = opts.env || process.env;
  const registry = opts.registry || buildRegistry({ env });
  const id =
    (modelId && String(modelId).trim()) ||
    (env.MODEL_ID && String(env.MODEL_ID).trim()) ||
    'deepseek-v4-flash';

  let entry = registry.get(id);
  if (!entry) {
    // Unknown model: fail closed rather than inventing capabilities.
    throw new ModelRegistryError(
      `Model "${id}" is not registered`,
      { code: 'model_not_found', modelId: id },
    );
  }
  if (!entry.enabled && !opts.allowDisabled) {
    throw new ModelRegistryError(
      `Model "${id}" is disabled`,
      { code: 'model_disabled', modelId: id },
    );
  }
  if (opts.applyOverrides !== false) {
    entry = applyEnvOverrides(entry, env);
  }
  return entry;
}

/**
 * Convert a registry entry into a pi-ai Model object for createAgentSession.
 *
 * @param {ModelEntry} entry
 * @param {{
 *   baseUrl?: string,
 *   apiKey?: string,
 * }} [runtime]
 */
export function toPiModel(entry, runtime = {}) {
  const cost = {
    input: entry.pricing.input_per_mtok,
    output: entry.pricing.output_per_mtok,
    cacheRead: entry.pricing.cache_read_per_mtok,
    cacheWrite: entry.pricing.cache_write_per_mtok,
  };
  return {
    id: entry.model_id,
    name: entry.name || entry.model_id,
    api: entry.api_protocol,
    provider: entry.provider,
    baseUrl: runtime.baseUrl || '',
    headers: runtime.apiKey
      ? { Authorization: `Bearer ${runtime.apiKey}` }
      : undefined,
    input: [...entry.input_modalities],
    output: ['text'],
    cost,
    contextWindow: entry.context_window,
    maxTokens: entry.max_output_tokens,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: Boolean(entry.supports_developer_role),
      maxTokensField: 'max_tokens',
      requiresAssistantAfterToolResult: true,
    },
  };
}

/**
 * Estimate USD cost from token counts and per-mtok pricing.
 * @param {ModelPricing} pricing
 * @param {{ input?: number, output?: number, cacheRead?: number, cacheWrite?: number }} tokens
 */
export function estimateCost(pricing, tokens = {}) {
  const input = Number(tokens.input) || 0;
  const output = Number(tokens.output) || 0;
  const cacheRead = Number(tokens.cacheRead) || 0;
  const cacheWrite = Number(tokens.cacheWrite) || 0;
  const p = pricing || ZERO_PRICING;
  const costInput = (input / 1_000_000) * (p.input_per_mtok || 0);
  const costOutput = (output / 1_000_000) * (p.output_per_mtok || 0);
  const costCacheRead = (cacheRead / 1_000_000) * (p.cache_read_per_mtok || 0);
  const costCacheWrite = (cacheWrite / 1_000_000) * (p.cache_write_per_mtok || 0);
  return {
    input: costInput,
    output: costOutput,
    cache_read: costCacheRead,
    cache_write: costCacheWrite,
    total: costInput + costOutput + costCacheRead + costCacheWrite,
  };
}

/**
 * Aggregate usage from pi-ai assistant messages (or raw usage objects).
 *
 * @param {unknown[]} messages
 * @param {ModelEntry} entry
 * @returns {TokenUsage}
 */
export function aggregateUsageFromMessages(messages, entry) {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  const list = Array.isArray(messages) ? messages : [];
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const usage = m.usage;
    if (!usage || typeof usage !== 'object') continue;
    // Only count assistant-side usage (provider responses).
    if (m.role && m.role !== 'assistant') continue;
    input += Number(usage.input) || Number(usage.input_tokens) || Number(usage.prompt_tokens) || 0;
    output += Number(usage.output) || Number(usage.output_tokens) || Number(usage.completion_tokens) || 0;
    cacheRead += Number(usage.cacheRead) || Number(usage.cache_read) || 0;
    cacheWrite += Number(usage.cacheWrite) || Number(usage.cache_write) || 0;
  }
  const total = input + output + cacheRead + cacheWrite;
  const cost = estimateCost(entry.pricing, {
    input,
    output,
    cacheRead,
    cacheWrite,
  });
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    total_tokens: total,
    cost,
    model_id: entry.model_id,
    provider: entry.provider,
  };
}

/**
 * Build usage payload from a single OpenAI-style usage object.
 * @param {Record<string, unknown>|null|undefined} usage
 * @param {ModelEntry} entry
 * @returns {TokenUsage}
 */
export function usageFromProviderResponse(usage, entry) {
  const input =
    Number(usage?.prompt_tokens) ||
    Number(usage?.input) ||
    Number(usage?.input_tokens) ||
    0;
  const output =
    Number(usage?.completion_tokens) ||
    Number(usage?.output) ||
    Number(usage?.output_tokens) ||
    0;
  const cacheRead =
    Number(usage?.cache_read_tokens) ||
    Number(usage?.cacheRead) ||
    0;
  const cacheWrite =
    Number(usage?.cache_write_tokens) ||
    Number(usage?.cacheWrite) ||
    0;
  const cost = estimateCost(entry.pricing, {
    input,
    output,
    cacheRead,
    cacheWrite,
  });
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    total_tokens: input + output + cacheRead + cacheWrite,
    cost,
    model_id: entry.model_id,
    provider: entry.provider,
  };
}

/**
 * List enabled models (for admin / capability switch UIs).
 * @param {Map<string, ModelEntry>} [registry]
 * @returns {ModelEntry[]}
 */
export function listEnabledModels(registry) {
  const map = registry || buildRegistry();
  return [...map.values()].filter((m) => m.enabled);
}

/** Module-level default registry (lazy, reloaded only on process restart). */
let _defaultRegistry = null;

/**
 * @param {{ force?: boolean, env?: NodeJS.ProcessEnv | Record<string, string|undefined> }} [opts]
 */
export function getDefaultRegistry(opts = {}) {
  if (!_defaultRegistry || opts.force) {
    _defaultRegistry = buildRegistry({ env: opts.env || process.env });
  }
  return _defaultRegistry;
}

/**
 * Reset cached default registry (tests).
 */
export function resetDefaultRegistry() {
  _defaultRegistry = null;
}
