import { createSandboxToolsExtension } from './extensions/sandbox-tools/index.js';
import { createDynamicResourcesExtension } from './extensions/dynamic-resources/index.js';
import { createObservabilityExtension } from './extensions/observability/index.js';
import { createMcpExtension } from './extensions/mcp/index.js';
import { createTaskPlanExtension } from './extensions/task-plan/index.js';
import { createContextManagementExtension } from './extensions/context-management/index.js';
import { createInteractionExtension } from './extensions/interaction/index.js';
import { createPromptExtension } from './extensions/prompt/index.js';
import { createStructuredOutputExtension } from './extensions/structured-output/index.js';
import { createSkillManagementExtension } from './extensions/skill-management/index.js';
import { createSandboxSecurityExtension } from './extensions/policy/index.js';
import { createCapabilityIntrospectionExtension } from './extensions/capability-introspection/index.js';
import { sanitizeUntrustedText } from '../../lib/text-redaction.js';

const MAX_FACTORY_ERROR = 240;

function isThenable(value) {
  return value != null && typeof value.then === 'function';
}

const KNOWN_EXTENSIONS = new Set([
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

/**
 * Wrap a named extension factory so success/failure is recorded in the
 * capability registry. Preserves Pi semantics: factory errors rethrow after
 * the failed status is registered.
 *
 * @param {string} name
 * @param {Function} factory
 * @param {{ getCapabilityRegistry?: Function, capabilityRegistry?: object, packageName?: string }} options
 */
function registerExtensionFactoryStatus(registry, name, status, options, metadata = {}) {
  if (!registry) return;
  registry.register(
    {
      kind: 'extension',
      name,
      status,
      source: options.packageName || 'enterprise-agent-kit',
      description:
        status === 'active'
          ? `Extension ${name} factory executed successfully`
          : `Extension ${name} factory failed`,
      dynamic: false,
      metadata,
      scope: 'extension_factories',
    },
    'extension_factory',
  );
}

function registerExtensionFactoryFailed(registry, name, options, error) {
  try {
    registerExtensionFactoryStatus(registry, name, 'failed', options, {
      error:
        sanitizeUntrustedText(error?.message || String(error || 'factory failed'), MAX_FACTORY_ERROR) ||
        'factory failed',
      reason: 'factory_error',
    });
  } catch {
    // Registry observer must not mask the original factory error.
  }
}

export function wrapNamedExtensionFactory(name, factory, options = {}) {
  if (typeof factory !== 'function') {
    throw new Error(`Extension factory for ${name} must be a function`);
  }
  return function trackedExtensionFactory(pi) {
    const registry =
      (typeof options.getCapabilityRegistry === 'function'
        ? options.getCapabilityRegistry()
        : null) ||
      options.capabilityRegistry ||
      null;
    try {
      const result = factory(pi);
      if (isThenable(result)) {
        return Promise.resolve(result)
          .then((resolved) => {
            registerExtensionFactoryStatus(registry, name, 'active', options);
            return resolved;
          })
          .catch((error) => {
            registerExtensionFactoryFailed(registry, name, options, error);
            throw error;
          });
      }
      registerExtensionFactoryStatus(registry, name, 'active', options);
      return result;
    } catch (error) {
      registerExtensionFactoryFailed(registry, name, options, error);
      throw error;
    }
  };
}

/**
 * Build the internal package factories selected by an Agent Profile.
 * Runtime clients are captured by closures and never added to Pi's context.
 */
export function createEnterpriseAgentKit(options) {
  const profile = options.profile;
  const requested = new Set(profile?.extensions || []);
  const unknown = [...requested].filter(
    (name) => !KNOWN_EXTENSIONS.has(name),
  );
  if (unknown.length) {
    throw new Error(`Agent profile contains unknown extensions: ${unknown.join(', ')}`);
  }

  const trackOpts = {
    getCapabilityRegistry: options.getCapabilityRegistry,
    capabilityRegistry: options.capabilityRegistry,
    packageName: options.packageName || 'enterprise-agent-kit',
  };

  /** @type {Array<{ name: string, factory: Function }>} */
  const named = [];

  if (requested.has('sandbox-tools')) {
    named.push({
      name: 'sandbox-tools',
      factory: createSandboxToolsExtension({
        tools: options.sandboxTools,
        toolOptions: options.sandboxToolOptions,
        allowedTools: profile.allowedTools,
        capabilityRegistry: options.capabilityRegistry,
      }),
    });
  }
  if (requested.has('skill-management')) {
    named.push({
      name: 'skill-management',
      factory: createSkillManagementExtension({
        mode: options.skillsMode,
        tools: options.skillTools,
        allowedTools: profile.allowedTools,
      }),
    });
  }
  if (requested.has('capability-introspection')) {
    named.push({
      name: 'capability-introspection',
      factory: createCapabilityIntrospectionExtension({
        getRegistry: options.getCapabilityRegistry,
        allowedTools: profile.allowedTools,
        emit: options.emit,
        getMeta: options.getMeta,
      }),
    });
  }
  if (requested.has('policy')) {
    named.push({
      name: 'policy',
      factory: createSandboxSecurityExtension(options.policyOptions || {}),
    });
  }
  if (requested.has('dynamic-resources')) {
    named.push({
      name: 'dynamic-resources',
      factory: createDynamicResourcesExtension({
        profile,
        extraSkillPaths: options.extraSkillPaths,
        extraPromptPaths: options.extraPromptPaths,
        emit: options.emit,
        getMeta: options.getMeta,
      }),
    });
  }
  if (requested.has('observability')) {
    named.push({
      name: 'observability',
      factory: createObservabilityExtension({
        emit: options.emit,
        getMeta: options.getMeta,
      }),
    });
  }
  if (requested.has('mcp') && options.mcpManager) {
    named.push({
      name: 'mcp',
      factory: createMcpExtension({
        manager: options.mcpManager,
        emit: options.emit,
        getMeta: options.getMeta,
        createApproval: options.createApproval,
        onApprovalSuspend: options.onApprovalSuspend,
        getPreApprovedAttempt: options.getPreApprovedAttempt,
        claimPreApprovedAttempt: options.claimPreApprovedAttempt,
        releasePreApprovedAttempt: options.releasePreApprovedAttempt,
        consumePreApprovedAttempt: options.consumePreApprovedAttempt,
        approvalMode: options.approvalMode,
        capabilityRegistry: options.capabilityRegistry,
        getCapabilityRegistry: options.getCapabilityRegistry,
        configuredMcpServers: options.configuredMcpServers,
        configuredServerIds: options.configuredMcpServerIds,
      }),
    });
  }
  if (requested.has('task-plan')) {
    named.push({
      name: 'task-plan',
      factory: createTaskPlanExtension({
        emit: options.emit,
        getMeta: options.getMeta,
        project: options.projectTaskPlan,
      }),
    });
  }
  if (requested.has('context-management')) {
    named.push({
      name: 'context-management',
      factory: createContextManagementExtension({
        emit: options.emit,
        getMeta: options.getMeta,
        policy: profile.contextPolicy,
      }),
    });
  }
  if (requested.has('interaction')) {
    named.push({
      name: 'interaction',
      factory: createInteractionExtension({
        emit: options.emit,
        getMeta: options.getMeta,
        onInputSuspend: options.onInputSuspend,
      }),
    });
  }
  if (requested.has('prompt')) {
    named.push({
      name: 'prompt',
      factory: createPromptExtension({
        productPrompt: options.productPrompt,
        logicalCwd: options.logicalCwd,
        skillsMode: options.skillsMode,
      }),
    });
  }
  if (requested.has('structured-output')) {
    named.push({
      name: 'structured-output',
      factory: createStructuredOutputExtension({
        emit: options.emit,
        getMeta: options.getMeta,
      }),
    });
  }

  // Optional test/hook injection of a named factory (fail-closed after wrap).
  if (options.extraNamedFactories) {
    for (const item of options.extraNamedFactories) {
      if (item?.name && typeof item.factory === 'function' && requested.has(item.name)) {
        named.push({ name: item.name, factory: item.factory });
      }
    }
  }

  return named.map(({ name, factory }) =>
    wrapNamedExtensionFactory(name, factory, trackOpts),
  );
}

export { KNOWN_EXTENSIONS };
