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
 *
 * Why this is not `pi.registerProvider()`
 * ---------------------------------------
 * Pi's ExtensionAPI can register a whole provider with its models, and that is
 * the right tool for an interactive client where the user picks a model from a
 * list. It does not fit here, for two reasons:
 *
 *  1. Ordering. `registerProvider` is only reachable from inside an extension
 *     factory, and extensions bind *after* `createAgentSessionFromServices`
 *     has already been handed the model. A Run's model is AgentVersion policy
 *     decided before the session exists, so registering a catalog the session
 *     will never consult buys nothing.
 *  2. Credentials. `ProviderConfig.apiKey` is a literal or env reference baked
 *     into the registration. The current path keeps the LLMIO key in a
 *     request-scoped `AuthStorage.inMemory` and out of the Model descriptor
 *     entirely (`assertModelShape` actively rejects credential fields on it).
 *     Moving the key into a per-Run provider registration widens that boundary.
 *
 * So this module stays the enterprise catalog and `toPiModel` stays the seam
 * that hands one concrete pi-ai Model to the runtime.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Platform defaults for models whose registry does not declare larger limits. */
export const DEFAULT_CONTEXT_WINDOW = 262144;
export const DEFAULT_MAX_OUTPUT_TOKENS = 65536;

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
    context_window: DEFAULT_CONTEXT_WINDOW,
    max_output_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
    supports_tool_call: true,
    supports_developer_role: false,
    supports_reasoning: false,
    thinking_levels: Object.freeze([]),
    default: true,
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
    context_window: DEFAULT_CONTEXT_WINDOW,
    max_output_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
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
    max_output_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
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
    context_window: DEFAULT_CONTEXT_WINDOW,
    max_output_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
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
    context_window: DEFAULT_CONTEXT_WINDOW,
    max_output_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
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
    context_window: DEFAULT_CONTEXT_WINDOW,
    max_output_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
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
    context_window: Math.max(
      1,
      int(raw.context_window ?? raw.contextWindow, DEFAULT_CONTEXT_WINDOW),
    ),
    max_output_tokens: Math.max(
      1,
      int(
        raw.max_output_tokens ?? raw.maxTokens,
        DEFAULT_MAX_OUTPUT_TOKENS,
      ),
    ),
    supports_tool_call: bool(raw.supports_tool_call, true),
    supports_developer_role: bool(raw.supports_developer_role, false),
    supports_reasoning: bool(raw.supports_reasoning, false),
    thinking_levels: thinking,
    // Explicit provider wire values per thinking level (e.g. xhigh → "max"
    // for deepseek/anthropic). Absent → pi-ai default mapping applies.
    thinking_wire_map: isPlainObject(raw.thinking_wire_map)
      ? Object.freeze(
          Object.fromEntries(
            Object.entries(raw.thinking_wire_map).map(([k, v]) => [
              String(k),
              v == null ? null : String(v),
            ]),
          ),
        )
      : undefined,
    // Marks the fallback model used when neither the request, the
    // AgentVersion policy, nor MODEL_ID names one. Exactly one entry should
    // carry `default: true`; when several do, buildRegistry keeps the first.
    default: bool(raw.default, false),
    pricing,
    enabled: bool(raw.enabled, true),
  };
}

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
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
    join(__dirname, '../../../config/agent/model-registry.json'),
    join(process.cwd(), 'config/agent/model-registry.json'),
    join(process.cwd(), '../config/agent/model-registry.json'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Cached registry loader with mtime-based hot reload.
 *
 * Unlike {@link buildRegistry} (fresh file read per call), this keeps the
 * parsed map keyed by resolved path + mtimeMs. Editing MODEL_REGISTRY_PATH /
 * config/agent/model-registry.json is picked up on the next resolution
 * without a process restart, while steady-state resolution stays cheap.
 *
 * The cache lives in a closure (not module scope): it is a derived view of a
 * config file, never Run state — the no-authoritative-run-map guard only
 * whitelists function-scoped Maps.
 */
export const buildCachedRegistry = (() => {
  /** @type {Map<string, { mtimeMs: number, registry: Map<string, ModelEntry> }>} */
  const cache = new Map();
  /**
   * @param {NodeJS.ProcessEnv | Record<string, string|undefined>} [env]
   * @returns {Map<string, ModelEntry>}
   */
  return (env = process.env) => {
    const filePath = resolveRegistryPath(env);
    let mtimeMs = 0;
    if (filePath && existsSync(filePath)) {
      try {
        mtimeMs = statSync(filePath).mtimeMs;
      } catch {
        mtimeMs = 0;
      }
    }
    const cacheKey = filePath ?? '__seed-only__';
    const cached = cache.get(cacheKey);
    if (cached && cached.mtimeMs === mtimeMs) return cached.registry;
    const registry = buildRegistry({ env, filePath: filePath ?? undefined });
    cache.set(cacheKey, { mtimeMs, registry });
    return registry;
  };
})();

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
      /** @type {string[]} */
      const fromFile = [];
      for (const entry of loadModelsFromFile(filePath)) {
        map.set(entry.model_id, entry);
        fromFile.push(entry.model_id);
      }
      // Map.set keeps an existing key's insertion position, so a seed entry
      // flagged `default: true` would always be found first by
      // resolveDefaultModelId and silently beat the operator's choice. When
      // the file names a default, it is authoritative: clear the flag on
      // everything the file did not define.
      const fileIds = new Set(fromFile);
      const fileDeclaresDefault = fromFile.some(
        (id) => map.get(id)?.default === true,
      );
      if (fileDeclaresDefault) {
        for (const [id, entry] of map) {
          if (!fileIds.has(id) && entry.default === true) {
            map.set(id, { ...entry, default: false });
          }
        }
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
 * Resolve the fallback model id: the registry entry carrying `default: true`
 * (first one wins), falling back to SEED default for registries that declare
 * none. Keeps model selection data-driven — switching the default model is a
 * registry-file change, not a code change.
 *
 * @param {Map<string, ModelEntry>} registry
 * @returns {string}
 */
export function resolveDefaultModelId(registry) {
  for (const entry of registry.values()) {
    if (entry.default === true) return entry.model_id;
  }
  // Legacy fallback so registries without any `default` flag keep working.
  return 'deepseek-v4-flash';
}

/**
 * Apply backward-compatible env overrides onto a resolved entry.
 * MODEL_CONTEXT_WINDOW / MODEL_MAX_TOKENS only apply when they target the
 * active MODEL_ID (or when no model_id filter is set).
 * MODEL_OVERRIDES_JSON applies per-model overrides to ANY model:
 *   {"<model_id>": {"context_window": N, "max_output_tokens": N}}
 * Per-model JSON entries win over the legacy scalar env vars.
 *
 * @param {ModelEntry} entry
 * @param {NodeJS.ProcessEnv | Record<string, string|undefined>} [env]
 * @returns {ModelEntry}
 */
export function applyEnvOverrides(entry, env = process.env) {
  const next = { ...entry, pricing: { ...entry.pricing } };
  let applied = false;
  const envModelId = env.MODEL_ID != null ? String(env.MODEL_ID).trim() : '';
  // Env token limits apply to the default/active model only.
  const appliesToThis =
    !envModelId || envModelId === entry.model_id;

  if (appliesToThis) {
    if (env.MODEL_CONTEXT_WINDOW != null && String(env.MODEL_CONTEXT_WINDOW).trim() !== '') {
      const cw = parseInt(String(env.MODEL_CONTEXT_WINDOW), 10);
      if (Number.isFinite(cw) && cw > 0) { next.context_window = cw; applied = true; }
    }
    if (env.MODEL_MAX_TOKENS != null && String(env.MODEL_MAX_TOKENS).trim() !== '') {
      const mt = parseInt(String(env.MODEL_MAX_TOKENS), 10);
      if (Number.isFinite(mt) && mt > 0) { next.max_output_tokens = mt; applied = true; }
    }
  }
  for (const [key, patch] of parseModelOverridesJson(env)) {
    if (key !== entry.model_id) continue;
    const cw = int(patch.context_window ?? patch.contextWindow, NaN);
    if (Number.isFinite(cw) && cw > 0) { next.context_window = cw; applied = true; }
    const mt = int(patch.max_output_tokens ?? patch.maxTokens, NaN);
    if (Number.isFinite(mt) && mt > 0) { next.max_output_tokens = mt; applied = true; }
  }
  return applied ? next : entry;
}

/**
 * Parse MODEL_OVERRIDES_JSON once per call. Malformed JSON or non-object
 * shapes are warned and ignored (overrides are an operator convenience, not
 * authority) — never a Run failure.
 *
 * @param {NodeJS.ProcessEnv | Record<string, string|undefined>} env
 * @returns {Array<[string, Record<string, unknown>]>}
 */
function parseModelOverridesJson(env) {
  const raw = env.MODEL_OVERRIDES_JSON;
  if (raw == null || String(raw).trim() === '') return [];
  try {
    const parsed = JSON.parse(String(raw));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    return Object.entries(parsed).filter(
      ([, v]) => v != null && typeof v === 'object' && !Array.isArray(v),
    );
  } catch (err) {
    console.warn(
      '[model-registry] Ignoring malformed MODEL_OVERRIDES_JSON:',
      err instanceof Error ? err.message : err,
    );
    return [];
  }
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
  const registry =
    opts.registry || (opts.useCached ? buildCachedRegistry(env) : buildRegistry({ env }));
  const id =
    (modelId && String(modelId).trim()) ||
    (env.MODEL_ID && String(env.MODEL_ID).trim()) ||
    resolveDefaultModelId(registry);

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

/** pi-ai ThinkingLevel values, weakest to strongest. */
export const THINKING_LEVELS = Object.freeze([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]);

/**
 * Project a registry entry's `thinking_levels` allowlist into the pi-ai
 * `thinkingLevelMap`.
 *
 * pi-ai reads the map two ways at once, and both matter here:
 *
 *  - support: `null` marks a level unsupported; `undefined` means "supported,
 *    use the provider default". `xhigh` is the exception — it counts as
 *    supported only when explicitly mapped (`models.js` getSupportedThinkingLevels).
 *  - wire value: whatever the map holds is sent verbatim, e.g.
 *    `reasoning_effort = thinkingLevelMap?.[level] ?? level`
 *    (`api/openai-completions.js`).
 *
 * So a declared level must be left unmapped: inventing a value here would
 * change what goes on the wire for models that already work. That leaves no way
 * to express a supported `xhigh` without also naming the provider's literal for
 * it — providers disagree (`deepseek` and `anthropic` both use `"max"`, while
 * an OpenAI-compatible gateway only accepts `minimal|low|medium|high`). Rather
 * than guess and turn a config typo into a 400 for the whole Run, `xhigh` is
 * mapped to null until the registry carries an explicit wire value for it.
 *
 * Returns undefined when the entry declares nothing, which preserves pi-ai's
 * default for reasoning models.
 *
 * @param {ModelEntry} entry
 * @returns {Record<string, string|null> | undefined}
 */
export function toThinkingLevelMap(entry) {
  if (!entry?.supports_reasoning) return undefined;
  const allowed = declaredThinkingLevels(entry);
  if (allowed.size === 0) return undefined;

  // Explicit per-level wire values from the registry entry (thinking_wire_map)
  // override the conservative defaults below. This is how xhigh becomes
  // usable: a provider that accepts it (deepseek/anthropic "max") declares
  // the mapping, providers that do not simply leave it out.
  const wireMap = entry.thinking_wire_map ?? {};

  /** @type {Record<string, string|null>} */
  const map = {};
  for (const level of THINKING_LEVELS) {
    // A wire value says *how* to send a level, not *whether* the model offers
    // it. Applying it to an undeclared level would make pi-ai report a level
    // that supportedThinkingLevels() still filters out, and the two must
    // agree (see that function's contract).
    if (
      allowed.has(level) &&
      Object.prototype.hasOwnProperty.call(wireMap, level)
    ) {
      map[level] = wireMap[level]; // explicit wire value (string or null)
      continue;
    }
    // Without an explicit wire value, xhigh has no portable mapping and stays
    // unsupported rather than guessed.
    if (!allowed.has(level) || level === 'xhigh') {
      map[level] = null;
    }
  }
  return Object.keys(map).length > 0 ? map : undefined;
}

/**
 * @param {ModelEntry} entry
 * @returns {Set<string>}
 */
function declaredThinkingLevels(entry) {
  const declared = Array.isArray(entry?.thinking_levels)
    ? entry.thinking_levels.map((level) => String(level).trim().toLowerCase())
    : [];
  return new Set(declared.filter((level) => THINKING_LEVELS.includes(level)));
}

/**
 * Thinking levels this entry actually offers, in pi-ai order.
 * `[]` for a non-reasoning model.
 *
 * Must agree with what pi-ai's `getSupportedThinkingLevels` will report for the
 * Model that `toPiModel` produces — an admin or capability UI built on this
 * should not advertise a level the session then clamps away. That is why
 * `xhigh` is excluded unless the entry declares an explicit wire value for it
 * via `thinking_wire_map` (pi-ai drops xhigh whenever the map does not name it).
 *
 * @param {ModelEntry} entry
 * @returns {string[]}
 */
export function supportedThinkingLevels(entry) {
  if (!entry?.supports_reasoning) return [];
  const wireMap = entry.thinking_wire_map ?? {};
  const portable = THINKING_LEVELS.filter(
    (level) =>
      level !== 'xhigh' ||
      (Object.prototype.hasOwnProperty.call(wireMap, level) &&
        wireMap[level] != null),
  );
  const allowed = declaredThinkingLevels(entry);
  if (allowed.size === 0) return portable;
  return portable.filter((level) => allowed.has(level));
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
  const thinkingLevelMap = toThinkingLevelMap(entry);
  // pi-ai Model shape (types.d.ts): id, name, api, provider, baseUrl, reasoning,
  // input, cost, contextWindow, maxTokens, optional headers/compat.
  // Do NOT set ImagesModel-only `output`.
  return {
    id: entry.model_id,
    name: entry.name || entry.model_id,
    api: entry.api_protocol,
    provider: entry.provider,
    baseUrl: runtime.baseUrl || '',
    reasoning: Boolean(entry.supports_reasoning),
    // Registry `thinking_levels` is the capability contract; without this the
    // field was collected and then dropped, and pi-ai treated every reasoning
    // model as supporting all five levels.
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    // Request credentials belong to Pi ModelRegistry/AuthStorage, not the
    // immutable Model descriptor.
    headers: runtime.headers,
    input: [...entry.input_modalities],
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
 * Token accounting and cost live in pi-ai, not here.
 *
 * There used to be a second cost engine in this module (estimateCost /
 * aggregateUsageFromMessages / usageFromProviderResponse). It ran on the same
 * inputs pi-ai already uses — `Model.cost`, which `toPiModel` fills from this
 * registry's `pricing` — so pi-ai's `usage.cost` on every assistant message was
 * always the same number, computed one layer down. Nothing in the service read
 * the local copy; the observability extension takes usage and cost straight off
 * the assistant message via `extractUsageSummary`.
 *
 * Pricing stays here because it is enterprise catalog data. The arithmetic on
 * it does not.
 */

/**
 * List enabled models (for admin / capability switch UIs).
 * @param {Map<string, ModelEntry>} [registry]
 * @returns {ModelEntry[]}
 */
export function listEnabledModels(registry) {
  const map = registry || buildRegistry();
  return [...map.values()].filter((m) => m.enabled);
}
