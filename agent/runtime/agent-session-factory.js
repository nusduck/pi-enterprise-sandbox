import { createAgentSession } from '@earendil-works/pi-coding-agent';
import {
  createExtensionHostAdapter,
  emitExtensionDiagnostics,
} from './extension-host-adapter.js';

/** Build the Pi SDK options in one place so cwd/session metadata cannot drift. */
export function buildAgentSessionOptions(options) {
  return {
    model: options.model,
    tools: options.tools,
    customTools: options.customTools,
    cwd: options.sessionCwd,
    sessionManager: options.sessionManager,
    authStorage: options.authStorage,
    modelRegistry: options.modelRegistry,
    resourceLoader: options.resourceLoader,
    settingsManager: options.settingsManager,
    sessionStartEvent: options.sessionStartEvent,
  };
}

/**
 * Create and bind one Pi AgentSession. No prompt may run before this resolves.
 */
export async function createBoundAgentSession(options) {
  const created = await createAgentSession(buildAgentSessionOptions(options));
  emitExtensionDiagnostics(created.extensionsResult, options.emit, {
    run_id: options.runId || null,
    conversation_id: options.conversationId || null,
    workspace_id: options.workspaceId || null,
  });

  const bindings =
    options.extensionBindings ||
    createExtensionHostAdapter({
      runId: options.runId,
      conversationId: options.conversationId,
      workspaceId: options.workspaceId,
      emit: options.emit,
      interactionManager: options.interactionManager,
      abortHandler: options.abortHandler,
      shutdownHandler: options.shutdownHandler,
    });

  await created.session.bindExtensions(bindings);
  return { ...created, extensionBindings: bindings };
}
