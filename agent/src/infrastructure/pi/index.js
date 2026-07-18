/**
 * Pi runtime integration (PR-05).
 * Slice A: factory, adapter, projector, codec.
 * Slice B: journal/recovery/PiRunExecutor live under application/ + mysql repos.
 */

export {
  PiSessionAdapterError,
  PiRuntimeFactoryError,
} from './errors.js';

export {
  PI_SESSION_JSONL_VERSION,
  PI_JSONL_ENTRY_TYPES,
  materializeJsonl,
  checksumJsonl,
  checksumSnapshotPayload,
  validateSnapshotPayload,
  parseAndValidateJsonl,
  verifySnapshotChecksum,
  buildSessionHeader,
  serializeJsonlLine,
} from './pi-jsonl-codec.js';

export {
  PiSessionAdapter,
  PRESERVED_ENTRY_TYPES,
} from './pi-session-adapter.js';

export {
  PiRuntimeFactory,
  PINNED_PI_SDK_VERSION,
  REQUIRED_ENTERPRISE_EXTENSIONS,
  assertModelShape,
  assertOptionalModelShape,
  assertSdkVersionPinned,
  bindAgentVersionConfig,
  resolveConcreteModel,
  resolveAgentVersionBindings,
  modelIdentityEqual,
  deepFreezeClone,
  buildExtensionBindings,
  assertExtensionsLoadedClean,
} from './pi-runtime-factory.js';

export {
  PlatformEventProjector,
  projectPiEvent,
  redactPayload,
  redactInlineSecrets,
  summarizeToolArgs,
  summarizeToolResult,
  summarizeAssistantMessage,
  extractAssistantTextForUi,
  extractToolCallBlocks,
  PROJECTOR_EVENT_TYPES,
} from './platform-event-projector.js';

export {
  findLeafEntryId,
  isAncestorOrSelf,
} from './pi-jsonl-codec.js';
