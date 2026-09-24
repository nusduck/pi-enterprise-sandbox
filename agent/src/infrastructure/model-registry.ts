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
 * `toRuntimeModel` is the seam that hands one concrete Model descriptor to the
 * DSH runtime factory. The factory reads only `provider` (→ DSH provider route),
 * `id` and `input` (image support); the remaining fields are the descriptor
 * contract that `assertModelShape` validates on AgentVersion model policies.
 * Reasoning effort does not travel on the descriptor — see
 * `dsh/reasoning-efforts.ts`.
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 过渡期宽松类型：注入的依赖多数还是 JS 类，形状由各自的模块负责。 */
type Loose = any;

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * 注册表 JSON / MODEL_OVERRIDES_JSON 里的原始对象。
 *
 * **刻意不收窄**：这是外部配置文件与环境变量的内容，字段名两种写法并存
 * （context_window / contextWindow、max_output_tokens / maxTokens），
 * 归一化正是 `normalizeEntry` 的职责。写成 `unknown` 会让每一次读字段都要
 * 断言一遍，把校验逻辑淹掉。
 */
type RawRegistryObject = Record<string, any>;

/** Platform defaults for models whose registry does not declare larger limits. */
export const DEFAULT_CONTEXT_WINDOW = 262144;
export const DEFAULT_MAX_OUTPUT_TOKENS = 65536;

/**
 * Built-in seed so the agent works without an external file mount.
 * Mirrors config/agent/model-registry.json.
 * @type {readonly import('./model-registry.js').ModelEntry[]}
 */
export const SEED_MODELS = Object.freeze([
  {
    provider: 'llmio',
    model_id: 'deepseek-flash',
    name: 'DeepSeek Flash',
    api_protocol: 'openai-completions',
    input_modalities: Object.freeze(['text', 'image']),
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
    model_id: 'qwen3.8-27b',
    name: 'Qwen 3.8 27B',
    api_protocol: 'openai-completions',
    input_modalities: Object.freeze(['text']),
    context_window: DEFAULT_CONTEXT_WINDOW,
    max_output_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
    supports_tool_call: true,
    supports_developer_role: false,
    supports_reasoning: false,
    thinking_levels: Object.freeze([]),
    pricing: Object.freeze({
      input_per_mtok: 0,
      output_per_mtok: 0,
      cache_read_per_mtok: 0,
      cache_write_per_mtok: 0,
    }),
    enabled: true,
  },
]);

export type ModelPricing = {
  input_per_mtok: number;
  output_per_mtok: number;
  cache_read_per_mtok: number;
  cache_write_per_mtok: number;
};

export type ModelEntry = {
  provider: string;
  model_id: string;
  name?: string;
  api_protocol: string;
  input_modalities: readonly string[];
  context_window: number;
  max_output_tokens: number;
  supports_tool_call: boolean;
  supports_developer_role: boolean;
  supports_reasoning: boolean;
  thinking_levels: readonly string[];
  pricing: ModelPricing;
  enabled: boolean;
  default?: boolean;
};

export class ModelRegistryError extends Error {
  // TS 要求类字段显式声明（JS 里它们只在构造器里赋值）。
  code: Loose;
  modelId: Loose;

  constructor(message: string, opts: { code?: string, modelId?: string|null } = {}) {
    super(message);
    this.name = 'ModelRegistryError';
    this.code = opts.code || 'model_registry_error';
    this.modelId = opts.modelId ?? null;
  }
}

/**
 * Normalize a raw registry object into a ModelEntry.
 * @param raw
 * @returns {ModelEntry}
 */
export function normalizeModelEntry(raw: Record<string, unknown>) {
  if (!raw || typeof raw !== 'object') {
    throw new ModelRegistryError('Invalid model entry', { code: 'invalid_entry' });
  }
  const modelId = String(raw.model_id || raw.id || '').trim();
  if (!modelId) {
    throw new ModelRegistryError('model_id is required', { code: 'missing_model_id' });
  }
  const pricingRaw =
    raw.pricing && typeof raw.pricing === 'object'
      ? (raw.pricing as Record<string, unknown>)
      : {};
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
    // Marks the fallback model used when neither the request, the
    // AgentVersion policy, nor MODEL_ID names one. Exactly one entry should
    // carry `default: true`; when several do, buildRegistry keeps the first.
    default: bool(raw.default, false),
    pricing,
    enabled: bool(raw.enabled, true),
  };
}

/**
 * @param v
 * @returns {v is Record<string, unknown>}
 */
function isPlainObject(v: unknown) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function num(v: unknown, fallback: number) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function int(v: unknown, fallback: number) {
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : fallback;
}

function bool(v: unknown, fallback: boolean) {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'no') return false;
  return fallback;
}

/**
 * Resolve path to the registry JSON file.
 * @param [env]
 * @returns {string|null}
 */
export function resolveRegistryPath(env: NodeJS.ProcessEnv | Record<string, string|undefined> = process.env) {
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
  const cache: Map<string, { mtimeMs: number, registry: Map<string, ModelEntry> }> = new Map();
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
 * Supports enterprise `{ models: [...] }` and dsh-style `{ providers: { p: { models: [...] } } }`.
 * @param filePath
 * @returns {ModelEntry[]}
 */
export function loadModelsFromFile(filePath: string) {
  const text = readFileSync(filePath, 'utf8');
  const data: RawRegistryObject = JSON.parse(text);
  const raws: Record<string, unknown>[] = [];
  if (Array.isArray(data?.models)) {
    raws.push(...data.models);
  } else if (data?.providers && typeof data.providers === 'object') {
    for (const [provider, pcfg] of Object.entries<RawRegistryObject>(
      data.providers,
    )) {
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
 *   seed?: readonly ModelEntry[],
 *   filePath?: string|null,
 *   env?: NodeJS.ProcessEnv | Record<string, string|undefined>,
 * }} [opts]
 * @returns {Map<string, ModelEntry>}
 */
export function buildRegistry(opts: { seed?: readonly ModelEntry[], filePath?: string|null, env?: NodeJS.ProcessEnv | Record<string, string|undefined>, } = {}) {
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
      const fromFile: string[] = [];
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
 * @param registry
 * @returns {string}
 */
export function resolveDefaultModelId(registry: Map<string, ModelEntry>) {
  for (const entry of registry.values()) {
    if (entry.default === true) return entry.model_id;
  }
  // Legacy fallback so registries without any `default` flag keep working.
  return 'deepseek-flash';
}

/**
 * Apply backward-compatible env overrides onto a resolved entry.
 * MODEL_CONTEXT_WINDOW / MODEL_MAX_TOKENS only apply when they target the
 * active MODEL_ID (or when no model_id filter is set).
 * MODEL_OVERRIDES_JSON applies per-model overrides to ANY model:
 *   {"<model_id>": {"context_window": N, "max_output_tokens": N}}
 * Per-model JSON entries win over the legacy scalar env vars.
 *
 * @param entry
 * @param [env]
 * @returns {ModelEntry}
 */
export function applyEnvOverrides(entry: ModelEntry, env: NodeJS.ProcessEnv | Record<string, string|undefined> = process.env) {
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
 * @param env
 * @returns {Array<[string, Record<string, unknown>]>}
 */
function parseModelOverridesJson(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): [string, RawRegistryObject][] {
  const raw = env.MODEL_OVERRIDES_JSON;
  if (raw == null || String(raw).trim() === '') return [];
  try {
    const parsed = JSON.parse(String(raw));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    return Object.entries(parsed).filter(
      ([, v]) => v != null && typeof v === 'object' && !Array.isArray(v),
    ) as [string, RawRegistryObject][];
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
 * @param modelId
 * @param {{
 *   registry?: Map<string, ModelEntry>,
 *   env?: NodeJS.ProcessEnv | Record<string, string|undefined>,
 *   allowDisabled?: boolean,
 *   applyOverrides?: boolean,
 *   useCached?: boolean,
 * }} [opts]
 * @returns {ModelEntry}
 */
export function resolveModel(modelId: string|null|undefined, opts: { registry?: Map<string, ModelEntry>, env?: NodeJS.ProcessEnv | Record<string, string|undefined>, allowDisabled?: boolean, applyOverrides?: boolean, useCached?: boolean, } = {}) {
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

/**
 * Convert a registry entry into the Model descriptor the DSH runtime factory takes.
 *
 * @param entry
 * @param {{
 *   baseUrl?: string,
 *   apiKey?: string,
 *   headers?: Record<string, string>,
 * }} [runtime]
 */
export function toRuntimeModel(entry: ModelEntry, runtime: { baseUrl?: string, apiKey?: string, headers?: Record<string, string>, } = {}) {
  const cost = {
    input: entry.pricing.input_per_mtok,
    output: entry.pricing.output_per_mtok,
    cacheRead: entry.pricing.cache_read_per_mtok,
    cacheWrite: entry.pricing.cache_write_per_mtok,
  };
  // Descriptor shape checked by assertModelShape: id, name, api, provider,
  // baseUrl, reasoning, input, cost, contextWindow, maxTokens, optional
  // headers/compat. Do NOT set image-model-only `output`.
  return {
    id: entry.model_id,
    name: entry.name || entry.model_id,
    api: entry.api_protocol,
    provider: entry.provider,
    baseUrl: runtime.baseUrl || '',
    reasoning: Boolean(entry.supports_reasoning),
    // Request credentials belong to DSH ModelRegistry/AuthStorage, not the
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
 * List enabled models (for admin / capability switch UIs).
 * @param [registry]
 * @returns {ModelEntry[]}
 */
export function listEnabledModels(registry?: Map<string, ModelEntry>) {
  const map = registry || buildRegistry();
  return [...map.values()].filter((m) => m.enabled);
}
