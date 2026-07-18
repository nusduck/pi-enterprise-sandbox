/**
 * MCP infrastructure seam (PR-06) — config validation + pi-mcp-adapter only.
 * No protocol client. No legacy McpConnectionManager.
 */

export {
  McpConfigError,
  loadMcpConfig,
  loadMcpConfigFromAgentVersion,
  parseAgentVersionConfigJson,
  assertNoPlaintextSecrets,
  mcpToolName,
  isValidMcpToolName,
} from './mcp-config-loader.js';

export {
  PiMcpAdapterError,
  PI_MCP_ADAPTER_PACKAGE,
  createPiMcpAdapter,
  resolveMcpBinding,
} from './pi-mcp-adapter-factory.js';
