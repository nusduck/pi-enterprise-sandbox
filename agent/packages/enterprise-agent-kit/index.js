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
]);

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

  const factories = [];
  if (requested.has('sandbox-tools')) {
    factories.push(
      createSandboxToolsExtension({
        tools: options.sandboxTools,
        toolOptions: options.sandboxToolOptions,
        allowedTools: profile.allowedTools,
      }),
    );
  }
  if (requested.has('skill-management')) {
    factories.push(createSkillManagementExtension({
      mode: options.skillsMode,
      tools: options.skillTools,
      allowedTools: profile.allowedTools,
    }));
  }
  if (requested.has('policy')) {
    factories.push(createSandboxSecurityExtension(options.policyOptions || {}));
  }
  if (requested.has('dynamic-resources')) {
    factories.push(
      createDynamicResourcesExtension({
        profile,
        extraSkillPaths: options.extraSkillPaths,
        extraPromptPaths: options.extraPromptPaths,
        emit: options.emit,
        getMeta: options.getMeta,
      }),
    );
  }
  if (requested.has('observability')) {
    factories.push(
      createObservabilityExtension({ emit: options.emit, getMeta: options.getMeta }),
    );
  }
  if (requested.has('mcp') && options.mcpManager) {
    factories.push(
      createMcpExtension({
        manager: options.mcpManager,
        emit: options.emit,
        getMeta: options.getMeta,
        createApproval: options.createApproval,
        onApprovalSuspend: options.onApprovalSuspend,
        getPreApprovedIds: options.getPreApprovedIds,
      }),
    );
  }
  if (requested.has('task-plan')) {
    factories.push(
      createTaskPlanExtension({
        emit: options.emit,
        getMeta: options.getMeta,
        project: options.projectTaskPlan,
      }),
    );
  }
  if (requested.has('context-management')) {
    factories.push(
      createContextManagementExtension({
        emit: options.emit,
        getMeta: options.getMeta,
        policy: profile.contextPolicy,
      }),
    );
  }
  if (requested.has('interaction')) {
    factories.push(
      createInteractionExtension({
        emit: options.emit,
        getMeta: options.getMeta,
        onInputSuspend: options.onInputSuspend,
      }),
    );
  }
  if (requested.has('prompt')) {
    factories.push(
      createPromptExtension({
        productPrompt: options.productPrompt,
        logicalCwd: options.logicalCwd,
        skillsMode: options.skillsMode,
      }),
    );
  }
  if (requested.has('structured-output')) {
    factories.push(createStructuredOutputExtension({
      emit: options.emit,
      getMeta: options.getMeta,
    }));
  }
  return factories;
}

export { KNOWN_EXTENSIONS };
