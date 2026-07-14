/**
 * Compatibility export for tests and downstream imports.
 * Runtime registration is owned by @company/pi-enterprise-agent-kit.
 */
export {
  createSandboxTools,
  getSandboxSessionId,
  sandboxTools,
  setApprovalNotifier,
  setSandboxSessionId,
} from './packages/enterprise-agent-kit/extensions/sandbox-tools/tool-definitions.js';
