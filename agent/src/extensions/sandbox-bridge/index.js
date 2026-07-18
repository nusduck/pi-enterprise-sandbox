/**
 * sandbox-bridge Extension (PR-06 B1 / PR-07B batch 2B).
 *
 * Registers exact 10 tools via pi.registerTool. Execution goes through an
 * explicit injected sandboxTransport port only (never legacy browser-Bearer
 * sandbox-client). Missing/partial transport fails at extension load.
 *
 * PR-07B batch 2B: deps.sandboxRequestBinder binds request-hash to the
 * RUNNING ToolExecution ledger row before any transport call. Missing binder
 * fails closed at execute (zero transport).
 */

import { SANDBOX_TOOL_NAMES } from './constants.js';
import { createSandboxBridgeToolDefinitions } from './tools/index.js';
import {
  assertRunTransportIdentity,
  assertSandboxTransport,
} from './transport.js';

export { SANDBOX_TOOL_NAMES } from './constants.js';
export {
  assertSandboxTransport,
  assertRunTransportIdentity,
  assertPositiveExecutionFenceToken,
  assertTransportToolCallId,
  buildTransportIdentity,
  buildTransportCallPayload,
  normalizeTransportToolCallId,
  SANDBOX_TRANSPORT_METHODS,
  RUN_TRANSPORT_IDENTITY_KEYS,
  RUN_TRANSPORT_STRING_IDENTITY_KEYS,
  TRANSPORT_CLAIM_KEYS,
  MAX_TOOL_CALL_ID_LEN,
} from './transport.js';
export { createSandboxBridgeToolDefinitions } from './tools/index.js';

/**
 * @param {{
 *   runContext: object,
 *   deps?: {
 *     sandboxTransport?: object | null,
 *     sandboxRequestBinder?: {
 *       bindSandboxRequest: Function,
 *     } | null,
 *     onSessionStart?: (event: object, ctx: object) => void | Promise<void>,
 *   },
 * }} options
 * @returns {import('@earendil-works/pi-coding-agent').ExtensionFactory}
 */
export function createSandboxBridgeExtension(options) {
  const runContext = options?.runContext;
  const deps = options?.deps ?? {};
  // Explicit port only — no sandboxClient alias/fallback.
  const transport = deps.sandboxTransport ?? null;
  const sandboxRequestBinder = deps.sandboxRequestBinder ?? null;

  /**
   * @param {import('@earendil-works/pi-coding-agent').ExtensionAPI} pi
   */
  function sandboxBridgeExtension(pi) {
    // Fail closed at load/registration — never start a run with unusable tools.
    assertRunTransportIdentity(runContext);
    const resolvedTransport = assertSandboxTransport(transport);

    const tools = createSandboxBridgeToolDefinitions(
      runContext,
      resolvedTransport,
      { sandboxRequestBinder },
    );
    for (const tool of tools) {
      pi.registerTool(tool);
    }

    pi.on('session_start', async (event, ctx) => {
      if (typeof deps.onSessionStart === 'function') {
        await deps.onSessionStart(event, ctx);
      }
    });
  }

  sandboxBridgeExtension.extensionName = 'sandbox-bridge';
  sandboxBridgeExtension.extensionMetadata = Object.freeze({
    name: 'sandbox-bridge',
    role: 'sandbox-routing',
    slice: 'B1+2B',
    toolsRegistered: true,
    toolNames: SANDBOX_TOOL_NAMES,
  });
  return sandboxBridgeExtension;
}
