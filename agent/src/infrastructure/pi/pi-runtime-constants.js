/**
 * Constants shared by the Pi runtime factory and its AgentVersion binding rules.
 *
 * Kept in their own module so `pi-runtime-factory.js` and
 * `agent-version-bindings.js` can both depend on them without a cycle.
 */

/** Exact SDK pin for this factory revision. */
export const PINNED_PI_SDK_VERSION = '0.80.3';

/**
 * Pi built-in tools that operate on the **Agent container's** filesystem.
 *
 * sandbox-bridge registers `read`/`write`/`edit`/`bash` under the same names,
 * so those four are shadowed by the sandbox-routed versions. `grep`/`find`/`ls`
 * have no sandbox counterpart: nothing shadows them, and they stay out of the
 * active set only because Pi's default happens to be exactly those first four
 * (`defaultActiveToolNames` in the SDK). That is an implicit contract — if a
 * future Pi release widens its default, this multi-tenant Agent container's own
 * filesystem becomes readable by the model, silently and without error.
 *
 * A denylist rather than the `tools` allowlist on purpose: MCP tool names are
 * discovered at runtime (`mcp__server__tool`), so an allowlist would filter
 * every MCP tool out of the session.
 *
 * @type {readonly string[]}
 */
export const LOCAL_FILESYSTEM_TOOL_NAMES = Object.freeze(['grep', 'find', 'ls']);

