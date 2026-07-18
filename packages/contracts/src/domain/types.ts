/**
 * Shared TypeScript domain types (plan §4).
 *
 * These are pure data contracts shared across BFF, Agent, Sandbox, and Frontend.
 * They intentionally do not depend on persistence or transport frameworks.
 */

import type { Iso8601Utc, Ulid } from '../ids.ts';

/** Tenant boundary. */
export interface Organization {
  orgId: Ulid;
  name: string;
  status: OrganizationStatus;
  createdAt: Iso8601Utc;
  updatedAt: Iso8601Utc;
}

export type OrganizationStatus = 'active' | 'suspended' | 'deleted';

/** User identity (may belong to multiple orgs; request always selects one). */
export interface User {
  userId: Ulid;
  /** External IdP subject (plan §8.2). */
  externalSubject: string;
  displayName: string | null;
  email: string | null;
  status: UserStatus;
  createdAt: Iso8601Utc;
  updatedAt: Iso8601Utc;
}

export type UserStatus = 'active' | 'disabled' | 'deleted';

/** Logical agent definition within an organization. */
export interface AgentDefinition {
  agentId: Ulid;
  orgId: Ulid;
  name: string;
  description: string | null;
  status: AgentDefinitionStatus;
  activeVersionId: Ulid | null;
  createdBy: Ulid;
  createdAt: Iso8601Utc;
  updatedAt: Iso8601Utc;
}

export type AgentDefinitionStatus = 'active' | 'archived' | 'draft';

/**
 * Immutable agent configuration snapshot (plan §8.5).
 * A Run binds to a concrete agent_version_id and must not drift.
 */
export interface AgentVersion {
  agentVersionId: Ulid;
  agentId: Ulid;
  versionNo: number;
  /** Full version config blob (modelPolicy, systemPrompt, extensions, …). */
  configJson: Record<string, unknown>;
  configHash: string;
  piSdkVersion: string;
  status: string;
  createdBy: Ulid;
  createdAt: Iso8601Utc;
}

/** User-level conversation container (not an execution environment). */
export interface Conversation {
  conversationId: Ulid;
  orgId: Ulid;
  userId: Ulid;
  agentId: Ulid;
  title: string | null;
  status: ConversationStatus;
  currentAgentSessionId: Ulid | null;
  createdAt: Iso8601Utc;
  updatedAt: Iso8601Utc;
  archivedAt: Iso8601Utc | null;
}

export type ConversationStatus = 'active' | 'archived' | 'deleted';

/**
 * Append-only conversation message row (plan §8.7).
 * Forbidden: storing all history as one Conversation JSON field.
 */
export interface Message {
  messageId: Ulid;
  conversationId: Ulid;
  agentSessionId: Ulid | null;
  runId: Ulid | null;
  role: MessageRole;
  messageType: MessageType;
  contentJson: Record<string, unknown>;
  sequenceNo: number;
  createdAt: Iso8601Utc;
}

export type MessageRole = 'user' | 'assistant' | 'tool' | 'system';

export type MessageType =
  | 'text'
  | 'multimodal'
  | 'tool_call'
  | 'tool_result'
  | 'status'
  | 'error';

/**
 * Pi Runtime + Workspace lifecycle unit.
 * One Agent Session owns exactly one Workspace.
 */
export interface AgentSession {
  agentSessionId: Ulid;
  orgId: Ulid;
  userId: Ulid;
  conversationId: Ulid;
  agentVersionId: Ulid;
  sandboxSessionId: Ulid;
  workspaceId: Ulid;
  status: AgentSessionStatus;
  piSessionVersion: number;
  lastRunId: Ulid | null;
  createdAt: Iso8601Utc;
  updatedAt: Iso8601Utc;
  closedAt: Iso8601Utc | null;
}

/** Agent Session state machine (plan §11). */
export type AgentSessionStatus =
  | 'CREATING'
  | 'ACTIVE'
  | 'SUSPENDED'
  | 'CLOSING'
  | 'CLOSED'
  | 'FAILED';

/** One user-message-triggered execution within an Agent Session (plan §8.10). */
export interface Run {
  runId: Ulid;
  orgId: Ulid;
  userId: Ulid;
  conversationId: Ulid;
  agentSessionId: Ulid;
  agentVersionId: Ulid;
  triggeringMessageId: Ulid;
  source: string;
  status: RunStatus;
  statusReason: string | null;
  queueName: string;
  attempt: number;
  traceId: string;
  /** Monotonic allocator for run_events.sequence_no (not MAX+1). */
  nextEventSequence: number;
  startedAt: Iso8601Utc | null;
  completedAt: Iso8601Utc | null;
  createdAt: Iso8601Utc;
  updatedAt: Iso8601Utc;
}

/** Append-only platform run event (plan §8.11). */
export interface RunEvent {
  eventId: Ulid;
  runId: Ulid;
  orgId: Ulid;
  sequenceNo: number;
  eventType: string;
  eventVersion: number;
  payloadJson: Record<string, unknown>;
  traceId: string;
  spanId: string | null;
  createdAt: Iso8601Utc;
}

/** Run state machine (plan §10). Terminal: SUCCEEDED | FAILED | CANCELLED. */
export type RunStatus =
  | 'ACCEPTED'
  | 'QUEUED'
  | 'STARTING'
  | 'RUNNING'
  | 'WAITING_APPROVAL'
  | 'WAITING_INPUT'
  | 'CANCELLING'
  | 'RETRYING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED';

export const RUN_TERMINAL_STATUSES = ['SUCCEEDED', 'FAILED', 'CANCELLED'] as const;
export type RunTerminalStatus = (typeof RUN_TERMINAL_STATUSES)[number];

export function isRunTerminalStatus(status: RunStatus): status is RunTerminalStatus {
  return (RUN_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** Sandbox management object for Workspace/execution resources (no agent chat). */
export interface SandboxSession {
  sandboxSessionId: Ulid;
  orgId: Ulid;
  userId: Ulid;
  agentSessionId: Ulid;
  workspaceId: Ulid;
  status: SandboxSessionStatus;
  createdAt: Iso8601Utc;
  updatedAt: Iso8601Utc;
}

export type SandboxSessionStatus = 'active' | 'closing' | 'closed' | 'failed';

/** Concrete tool execution kinds routed to Sandbox (plan §4.9). */
export type ExecutionKind =
  | 'file_read'
  | 'file_write'
  | 'file_edit'
  | 'command'
  | 'python'
  | 'node'
  | 'process_start'
  | 'process_signal'
  | 'artifact_submit';

export interface Execution {
  executionId: Ulid;
  orgId: Ulid;
  runId: Ulid;
  agentSessionId: Ulid;
  sandboxSessionId: Ulid;
  kind: ExecutionKind;
  status: ExecutionStatus;
  startedAt: Iso8601Utc | null;
  completedAt: Iso8601Utc | null;
}

export type ExecutionStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

/** Long-running process handle (plan §4.10). */
export interface ProcessHandle {
  processId: Ulid;
  executionId: Ulid;
  sandboxSessionId: Ulid;
  pid: number | null;
  status: ProcessStatus;
  startedAt: Iso8601Utc | null;
  endedAt: Iso8601Utc | null;
  exitCode: number | null;
}

export type ProcessStatus =
  | 'starting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timeout'
  | 'lost'
  | 'orphaned';

/** User dataset streamed into the session Workspace (not a message attachment blob). */
export interface Dataset {
  datasetId: Ulid;
  orgId: Ulid;
  userId: Ulid;
  agentSessionId: Ulid;
  workspaceId: Ulid;
  name: string;
  path: string;
  sizeBytes: number;
  status: DatasetStatus;
  createdAt: Iso8601Utc;
}

export type DatasetStatus = 'uploading' | 'ready' | 'failed';

/** Explicit user-deliverable file (only via submit_artifact). */
export interface Artifact {
  artifactId: Ulid;
  orgId: Ulid;
  userId: Ulid;
  agentSessionId: Ulid;
  runId: Ulid | null;
  name: string;
  path: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: Iso8601Utc;
}

/** Protocol-layer A2A task mapped to an internal Run (plan §4.13). */
export interface A2aTask {
  a2aTaskId: Ulid;
  orgId: Ulid;
  clientId: string;
  runId: Ulid;
  status: A2aTaskStatus;
  createdAt: Iso8601Utc;
  updatedAt: Iso8601Utc;
}

export type A2aTaskStatus =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'auth-required'
  | 'completed'
  | 'failed'
  | 'canceled';

/** Enterprise approval for high-risk external side effects. */
export interface Approval {
  approvalId: Ulid;
  orgId: Ulid;
  runId: Ulid;
  toolCallId: string;
  status: ApprovalStatus;
  riskLevel: 'low' | 'medium' | 'high';
  reason: string;
  createdAt: Iso8601Utc;
  resolvedAt: Iso8601Utc | null;
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

/**
 * Transactional outbox row for durable → Redis Stream delivery (plan §8.17, PR-03).
 *
 * Written in the same MySQL transaction as domain facts. A publisher claims
 * rows, appends to Redis Streams (at-least-once), then marks PUBLISHED.
 * Redis is never the authority for business state.
 */
export type OutboxStatus = 'PENDING' | 'PUBLISHING' | 'PUBLISHED' | 'FAILED';

export const OUTBOX_STATUSES = [
  'PENDING',
  'PUBLISHING',
  'PUBLISHED',
  'FAILED',
] as const;

export type OutboxStatusConst = (typeof OUTBOX_STATUSES)[number];

export function isOutboxStatus(value: unknown): value is OutboxStatus {
  return (
    typeof value === 'string' &&
    (OUTBOX_STATUSES as readonly string[]).includes(value)
  );
}

export interface DomainOutbox {
  outboxId: Ulid;
  aggregateType: string;
  aggregateId: Ulid;
  eventType: string;
  payloadJson: Record<string, unknown>;
  status: OutboxStatus;
  attempts: number;
  /** Present while status is PUBLISHING; used to guard completion updates. */
  claimToken: string | null;
  claimedAt: Iso8601Utc | null;
  /** When PENDING, publisher may claim only if null or <= now. */
  nextAttemptAt: Iso8601Utc | null;
  /** Bounded, sanitized error text from last failed publish attempt. */
  lastError: string | null;
  createdAt: Iso8601Utc;
  publishedAt: Iso8601Utc | null;
}
