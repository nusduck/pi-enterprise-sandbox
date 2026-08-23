/**
 * Constants shared by the Pi runtime factory and its AgentVersion binding rules.
 *
 * Kept in their own module so `pi-runtime-factory.js` and
 * `agent-version-bindings.js` can both depend on them without a cycle.
 */

/** Exact SDK pin for this factory revision. */
export const PINNED_PI_SDK_VERSION = '0.80.3';

import { PiRuntimeFactoryError } from './errors.js';

/**
 * Pi built-in tools that operate on the **Agent container's** filesystem.
 *
 * sandbox-bridge registers a sandbox-routed tool under each of these names
 * (as it does for `read`/`write`/`edit`/`bash`), so the built-in is shadowed
 * in the session's tool registry rather than removed from it: an extension
 * tool overwrites the built-in entry of the same name.
 *
 * They are NOT added to `excludeTools`. Exclusion is by name only and the SDK
 * applies it to extension tools too, so denying `ls`/`find`/`grep` there also
 * denies the sandbox replacements — which is exactly how the model lost
 * workspace search while the capability manifest kept advertising it.
 *
 * The boundary is instead enforced after bind by
 * {@link assertSandboxShadowedTools}: if any of these names still resolves to
 * the built-in implementation, the run fails closed rather than handing the
 * model a tool pointed at this multi-tenant container's own filesystem.
 *
 * @type {readonly string[]}
 */
export const LOCAL_FILESYSTEM_TOOL_NAMES = Object.freeze(['grep', 'find', 'ls']);

/**
 * Every tool name where a Pi built-in and a sandbox-bridge tool collide.
 * `read`/`write`/`edit`/`bash` were always shadow-only; the search trio joins
 * them now that sandbox-bridge implements it.
 *
 * @type {readonly string[]}
 */
export const SANDBOX_SHADOWED_TOOL_NAMES = Object.freeze([
  'read',
  'write',
  'edit',
  'bash',
  ...LOCAL_FILESYSTEM_TOOL_NAMES,
]);

/**
 * Tool names only sandbox-bridge ever registers. Their presence is how this
 * module recognises a session the bridge is actually bound to; a session
 * built without it (unit tests, non-enterprise factory callers) has no
 * sandbox tools to shadow the built-ins with and is left alone.
 *
 * @type {readonly string[]}
 */
const SANDBOX_BRIDGE_MARKER_TOOL_NAMES = Object.freeze([
  'process_start',
  'submit_artifact',
]);

/**
 * Fail closed when a shadowed name is still served by Pi's built-in.
 *
 * Only names actually present in the registry are checked: Pi is free to stop
 * shipping one of them, and a session built with `noExtensions` has none.
 *
 * @param {{ getAllTools?: () => Array<{ name?: string, sourceInfo?: { source?: string } }> }} session
 * @returns {string[]} the offending tool names (empty when the boundary holds)
 */
export function findUnshadowedLocalTools(session) {
  if (!session || typeof session.getAllTools !== 'function') return [];
  const tools = session.getAllTools() ?? [];
  const registered = new Set(tools.map((tool) => tool?.name));
  const bridgeBound = SANDBOX_BRIDGE_MARKER_TOOL_NAMES.some((name) =>
    registered.has(name),
  );
  if (!bridgeBound) return [];
  const shadowed = new Set(SANDBOX_SHADOWED_TOOL_NAMES);
  const offenders = [];
  for (const tool of tools) {
    if (!shadowed.has(tool?.name)) continue;
    if (tool?.sourceInfo?.source === 'builtin') offenders.push(tool.name);
  }
  return offenders;
}

/**
 * Fail-closed check: no tool name that sandbox-bridge is supposed to own may
 * still resolve to Pi's built-in implementation, which would read and write
 * this shared Agent container's filesystem instead of the tenant workspace.
 *
 * Runs after bindExtensions — before that the extension tools are not in the
 * registry yet and every shadowed name would look like a violation.
 *
 * @param {any} session
 */
export function assertSandboxShadowedTools(session) {
  const offenders = findUnshadowedLocalTools(session);
  if (offenders.length === 0) return;
  throw new PiRuntimeFactoryError(
    `Sandbox-shadowed tools resolved to the Agent container built-in (fail-closed): ${offenders.join(', ')}`,
    { code: 'PI_LOCAL_TOOL_NOT_SHADOWED' },
  );
}
