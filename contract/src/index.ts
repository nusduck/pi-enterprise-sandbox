/**
 * Agent 与执行面之间的共享契约。
 *
 * 设计要点：两侧同为 TypeScript 之后，接口不需要手写 DTO——直接复用
 * `@deepseek-ai/dsh-fs` 与 `dsh-shell` 的类型，本包只加 RPC 信封、HMAC 与
 * 错误码。详见 docs/design/dsh-rebuild.md §2、§5.6，docs/adr/0008 D5/D6/D8。
 *
 * 三个子模块：
 * - `envelope.ts` RPC 信封（含 workspaceId 多实例路由预留键）与统一响应包装
 * - `errors.ts`   FS_* 错误码复用 + 传输层错误码 + 脱敏错误映射
 * - `hmac.ts`      Agent -> Exec 内部调用令牌，两侧共用同一份实现
 * - `endpoint-failover.ts` 多端点建连的纯策略（粘主/拉黑/预算），无驱动依赖
 * - `dbpm.ts`      启动时向 DBPM 取口令的 TCP 客户端
 * - `dbpm-config.ts` 各进程取哪些口令、配置来源与「连接串不许夹口令」的启动约束
 * - `skill-manifest.ts` 已启用用户 Skill 清单、GET 规范化签名字节与版本目录规则
 * - `shell-payload.ts` 内部 shell run/start 请求体的两侧共用解析与边界校验
 */

export {
  assertEnvelope,
  errResult,
  okResult,
  parseEnvelope,
} from './envelope.js';
export type {
  RpcEnvelope,
  RpcFailure,
  RpcRequest,
  RpcResult,
  RpcSuccess,
} from './envelope.js';

export {
  ContractError,
  FsError,
  redactPhysicalPaths,
  toWireError,
} from './errors.js';
export type {
  ContractErrorCode,
  FsErrorCode,
  ToWireErrorOptions,
  TransportErrorCode,
  WireError,
} from './errors.js';

export {
  INTERNAL_TOKEN_ALGORITHM,
  INTERNAL_TOKEN_AUDIENCE,
  INTERNAL_TOKEN_CLAIM_KEYS,
  INTERNAL_TOKEN_DEFAULT_TTL_SECONDS,
  INTERNAL_TOKEN_HEADER_KEYS,
  INTERNAL_TOKEN_ISSUE_CLAIM_KEYS,
  INTERNAL_TOKEN_ISSUER,
  INTERNAL_TOKEN_MAX_TTL_SECONDS,
  INTERNAL_TOKEN_SUBJECT,
  INTERNAL_TOKEN_TYPE,
  INTERNAL_TOKEN_VERSION,
  InternalHmacError,
  issueInternalToken,
  signInternalToken,
  validateInternalHmacKeyring,
  validateInternalTokenClaims,
  verifyInternalToken,
} from './hmac.js';
export type {
  InternalHmacErrorCode,
  InternalHmacKeyringInput,
  InternalTokenClaims,
  InternalTokenIssueClaims,
  InternalTokenScope,
  IssueInternalTokenOptions,
  SignInternalTokenOptions,
  VerifyInternalTokenOptions,
} from './hmac.js';

export {
  acquireWithFailover,
  DEFAULT_ENDPOINT_BLACKLIST_MS,
  EndpointConfigError,
  EndpointSelector,
  errorCode,
  FailoverError,
  isNetworkError,
  parseEndpointList,
} from './endpoint-failover.js';
export type {
  ConnectFailureKind,
  Endpoint,
  EndpointPlan,
  FailoverAttemptContext,
  FailoverAttemptRecord,
  FailoverErrorCode,
  FailoverOptions,
} from './endpoint-failover.js';

export {
  buildDbpmRequest,
  DBPM_BUDGET_MS,
  DBPM_CONNECT_TIMEOUT_MS,
  DBPM_MAX_FRAME_BYTES,
  DBPM_REQUEST_HEADER,
  DBPM_REQUEST_TIMEOUT_MS,
  DbpmAttemptError,
  DbpmError,
  fetchDbpmPassword,
  parseDbpmResponseLine,
} from './dbpm.js';
export type {
  DbpmEntry,
  DbpmErrorCode,
  DbpmFailureCode,
  FetchDbpmPasswordOptions,
} from './dbpm.js';

export {
  assertUrlUser,
  assertUrlWithoutPassword,
  DbpmConfigError,
  fetchDbpmCredentials,
  readDbpmSettings,
} from './dbpm-config.js';
export type {
  DbpmCredentialRole,
  DbpmCredentials,
  DbpmSettings,
  FetchDbpmCredentialsOptions,
} from './dbpm-config.js';

export {
  buildSchemaManifest,
  diffSchemaManifest,
  loadSchemaManifest,
  SCHEMA_METADATA_QUERIES,
  SCHEMA_MIGRATIONS_QUERY,
  SchemaDriftError,
} from './schema-manifest.js';
export type { SchemaDrift, SchemaDriftKind, SchemaManifest } from './schema-manifest.js';

export {
  canonicalQueryBytes,
  ENABLED_SKILLS_MAX,
  parseEnabledSkills,
  parseSkillVersionSidecar,
  SKILL_DIGEST_PATTERN,
  SKILL_NAME_PATTERN,
  SKILL_VERSIONS_DIRNAME,
  skillVersionPaths,
} from './skill-manifest.js';
export type { EnabledSkillRef, SkillVersionPaths, SkillVersionSidecar } from './skill-manifest.js';
export {
  DEFAULT_SHELL_PAYLOAD_LIMITS,
  parseShellRunPayload,
  parseShellStartPayload,
  parseShellWorkdir,
  SANDBOX_TEMP_PATH,
  SANDBOX_WORKSPACE_PATH,
} from './shell-payload.js';
export type {
  ShellPayload,
  ShellPayloadLimits,
  ShellStartPayload,
  ShellWorkdir,
  ShellWorkdirScope,
} from './shell-payload.js';

// DSH `ctx.fs` 的类型直接复用，不手写 DTO——见包顶部说明。
export { FileSystem } from '@deepseek-ai/dsh-fs';
export type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsObservation,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs';

// DSH `ctx.shell` 的类型同理复用。
export { ShellExecutor } from '@deepseek-ai/dsh-shell';
export type {
  CollectedOutput,
  DshEnvironment,
  DshEnvironmentKey,
  ParsedExitStatus,
  ShellExecRequest,
  ShellExecSpec,
  ShellProcess,
  ShellProcessRead,
  ShellProcessStatus,
  ShellRunResult,
  ShellSandboxInfo,
} from '@deepseek-ai/dsh-shell';
