/**
 * Enterprise extension registry (plan §2.2).
 *
 * Extensions are Pi extensions (`(pi: ExtensionAPI) => void`) that ship inside
 * this image: statically imported, code-reviewed, deployed with the Agent.
 * They run inside the trust boundary (sandbox transport, governance recorder,
 * run context), so this registry is the only set that may load.
 *
 * Pi's own filesystem auto-discovery (`~/.pi/agent/extensions`,
 * `.pi/extensions`) stays disabled: this is a multi-tenant server and
 * `.pi/extensions` would be workspace-writable. Only explicit
 * `extensionFactories` reach the SDK.
 */

/**
 * Extensions that must load whenever the enterprise bundle is enabled.
 * Dropping any of these is a security regression, not a feature toggle:
 * without sandbox-bridge there are no tools, without enterprise-policy no
 * tool_call interception, without observability no durable audit ledger.
 *
 * @type {readonly ['sandbox-bridge', 'enterprise-policy', 'observability', 'user-interaction']}
 */
export const REQUIRED_EXTENSION_NAMES = Object.freeze([
  'sandbox-bridge',
  'enterprise-policy',
  'observability',
  'user-interaction',
]);

/**
 * Additional first-party extensions an AgentVersion may enable on top of the
 * required set. A new entry must also add a tool-risk-classifier entry for
 * every tool it registers, otherwise those tools are denied as
 * UNKNOWN_TOOL_DENIED (enforced by a guard test).
 *
 * `skill-lifecycle` is user-scoped and requires a writable per-user Skill
 * root. It is deliberately not named `skill-management` — that is a legacy
 * enterprise-agent-kit package name the registry must keep refusing.
 *
 * @type {readonly string[]}
 */
export const OPTIONAL_EXTENSION_NAMES = Object.freeze(['skill-lifecycle']);

/** Every extension name this build knows how to construct. */
export const REGISTERED_EXTENSION_NAMES = Object.freeze([
  ...REQUIRED_EXTENSION_NAMES,
  ...OPTIONAL_EXTENSION_NAMES,
]);

/**
 * Deterministic load order.
 *
 * The original core pipeline keeps positions 0..2 —
 * sandbox-bridge (registers tools) → enterprise-policy (intercepts every
 * tool_call, can block) → observability (records outcomes) — and every later
 * extension appends. Adding an extension therefore never reshuffles the
 * existing ones.
 *
 * Position only decides handler order within a Pi event: `tool_call` is a
 * global event, so enterprise-policy observes tools registered by *any*
 * extension no matter where it sits. An extension that only registers tools
 * (like user-interaction) is order-independent; one that adds a blocking
 * `tool_call` handler must be placed deliberately relative to
 * enterprise-policy.
 *
 * @type {readonly string[]}
 */
export const EXTENSION_LOAD_ORDER = Object.freeze([
  ...REQUIRED_EXTENSION_NAMES,
  ...OPTIONAL_EXTENSION_NAMES,
]);

/**
 * Pre-`user-interaction` required set. An AgentVersion authored before
 * ask_user was split out of enterprise-policy lists exactly these three.
 * Such a list stays valid and implies `user-interaction`, so ask_user does
 * not silently disappear from existing deployments.
 *
 * @type {readonly string[]}
 */
export const LEGACY_REQUIRED_EXTENSION_NAMES = Object.freeze([
  'sandbox-bridge',
  'enterprise-policy',
  'observability',
]);

/**
 * Legacy enterprise-agent-kit package names (12) — non-production only.
 * New production composition must not load these via package loader.
 * Note `interaction` is on this list, which is why the first-party
 * ask_user extension is named `user-interaction`.
 */
export const LEGACY_EXTENSION_PACKAGE_NAMES = Object.freeze([
  'sandbox-tools',
  'policy',
  'dynamic-resources',
  'observability',
  'mcp',
  'task-plan',
  'interaction',
  'context-management',
  'prompt',
  'structured-output',
  'skill-management',
  'capability-introspection',
]);
