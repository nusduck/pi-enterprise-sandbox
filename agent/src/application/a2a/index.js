/**
 * A2A application surface (PR-12 / plan §20).
 */

export {
  A2aCredentialService,
  A2aAuthError,
  publicCredentialView,
  parseBearerToken,
  verifyTokenHash,
  hashA2aToken,
  normalizeFutureExpiresAt,
  evaluateStoredExpiry,
} from './credential-service.js';

export {
  A2aTaskService,
  A2aTaskError,
  A2aAuditError,
  extractTextFromA2aMessage,
  parseSendParams,
  assertSendConfiguration,
  requireStableIdempotencyKey,
} from './task-service.js';

export {
  A2aStreamService,
  formatA2aSseHeartbeatComment,
} from './stream-service.js';

export {
  projectEnvelopeToA2aResult,
  buildA2aTaskObject,
  collectArtifactsFromEnvelopes,
  projectArtifactRowsToA2a,
  projectMessagesToA2aHistory,
} from './event-projector.js';

export {
  JSON_RPC_VERSION,
  JSON_RPC_ERROR,
  A2A_RPC_ERROR,
  A2A_METHODS,
  A2A_METHOD_ALIASES,
  A2A_PROTOCOL_VERSION,
  normalizeA2aMethod,
  parseJsonRpcRequest,
  jsonRpcSuccess,
  jsonRpcError,
  formatA2aSseRpcFrame,
} from './json-rpc.js';

export {
  buildAgentCard,
  resolvePublicBaseUrl,
  assertPublicBaseUrl,
  normalizeAgentSkills,
  defaultAgentSkills,
  resolveAgentCardSkills,
  listSkillsFromRoot,
  parseSkillMdFrontmatter,
  A2A_SUPPORTED_INPUT_MODES,
  A2A_SUPPORTED_OUTPUT_MODES,
  A2A_ENTERPRISE_EXTENSION_URI,
} from './agent-card.js';

export {
  mintArtifactDownloadToken,
  verifyArtifactDownloadToken,
  buildArtifactDownloadUri,
} from './artifact-download.js';

export { deterministicA2aTaskId } from './deterministic-task-id.js';
