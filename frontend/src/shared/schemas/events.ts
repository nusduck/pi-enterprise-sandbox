/**
 * Runtime Event Schema (ADR 0003 §15) + Zod validation.
 * Wire format: snake_case envelope with typed payload.
 */
import { z } from 'zod';

/** Known runtime event types. */
export const RUNTIME_EVENT_TYPES = [
  'run.created',
  'run.started',
  'run.status_changed',
  'run.completed',
  'run.failed',
  'run.trace',
  'message.started',
  'message.delta',
  'message.completed',
  'tool.prepared',
  'tool.approval_required',
  'tool.started',
  'tool.completed',
  'tool.failed',
  'process.started',
  'process.stdout',
  'process.stderr',
  'process.completed',
  'process.failed',
  'artifact.created',
  'session.restored',
  'session.compacted',
  'budget.warning',
  'budget.exceeded',
  'run.context_updated',
  'run.task_plan_updated',
  'run.compaction_updated',
] as const;

export type RuntimeEventType = (typeof RUNTIME_EVENT_TYPES)[number] | string;

/** Unified runtime event envelope. */
export const RuntimeEventSchema = z
  .object({
    event_id: z.string(),
    sequence: z.number().int().nonnegative(),
    run_id: z.string(),
    session_id: z.string().optional().nullable(),
    type: z.string(),
    timestamp: z.string().optional().nullable(),
    payload: z.record(z.string(), z.unknown()).optional().default({}),
  })
  .passthrough();

export type RuntimeEvent = z.infer<typeof RuntimeEventSchema> & {
  type: RuntimeEventType;
  payload: Record<string, unknown>;
};

/** Soft-parse: returns null when envelope is unusable. */
export function parseRuntimeEvent(data: unknown): RuntimeEvent | null {
  const result = RuntimeEventSchema.safeParse(data);
  if (!result.success) return null;
  const d = result.data;
  return {
    ...d,
    payload: (d.payload || {}) as Record<string, unknown>,
  };
}

/** Create a well-formed runtime event (tests / adapters). */
export function makeRuntimeEvent(
  partial: Partial<RuntimeEvent> & {
    event_id: string;
    sequence: number;
    run_id: string;
    type: string;
  },
): RuntimeEvent {
  const { payload: rawPayload, ...rest } = partial;
  return {
    session_id: null,
    timestamp: null,
    ...rest,
    payload: (rawPayload || {}) as Record<string, unknown>,
  };
}

// ── Create-run / rehydrate API shapes ──

export const CreateRunRequestSchema = z
  .object({
    conversation_id: z.string().optional().nullable(),
    session_id: z.string().optional().nullable(),
    messages: z.array(z.unknown()).optional(),
  })
  .passthrough();

export const CreateRunResponseSchema = z
  .object({
    run_id: z.string(),
    session_id: z.string().optional().nullable(),
    conversation_id: z.string().optional().nullable(),
    status: z.string().optional(),
  })
  .passthrough();

export const RunDetailSchema = z
  .object({
    id: z.string().optional(),
    run_id: z.string(),
    conversation_id: z.string().optional().nullable(),
    session_id: z.string().optional().nullable(),
    sandbox_session_id: z.string().optional().nullable(),
    agent_session_id: z.string().optional().nullable(),
    status: z.string(),
    last_sequence: z.number().optional().nullable(),
    last_event_id: z.string().optional().nullable(),
    error: z.string().optional().nullable(),
    started_at: z.string().optional().nullable(),
    finished_at: z.string().optional().nullable(),
    created_at: z.string().optional().nullable(),
    updated_at: z.string().optional().nullable(),
    event_count: z.number().int().nonnegative().optional(),
    next_sequence: z.number().int().nonnegative().optional(),
    runtime_available: z.boolean().optional(),
  })
  .passthrough();

/** Durable Sandbox tool ledger row used for reconnect/reload reconciliation. */
export const ToolExecutionSnapshotSchema = z
  .object({
    tool_call_id: z.string(),
    run_id: z.string(),
    status: z.string(),
    tool_name: z.string().optional().nullable(),
    arguments: z.record(z.string(), z.unknown()).optional().nullable(),
    result_summary: z.string().optional().nullable(),
    summary: z.string().optional().nullable(),
    error: z.string().optional().nullable(),
    result_json: z.unknown().optional().nullable(),
    created_at: z.string().optional().nullable(),
    updated_at: z.string().optional().nullable(),
    finished_at: z.string().optional().nullable(),
  })
  .passthrough();

export const PersistedAgentEventSchema = z
  .object({
    run_id: z.string(),
    sequence: z.number().int().positive(),
    event_id: z.string(),
    type: z.string(),
    payload: z.record(z.string(), z.unknown()).optional().default({}),
    schema_version: z.number().int().optional(),
    created_at: z.string().optional().nullable(),
  })
  .passthrough();

export const ConversationEventsResponseSchema = z
  .object({
    runs: z.array(RunDetailSchema).default([]),
    events: z.array(PersistedAgentEventSchema).default([]),
    last_run: RunDetailSchema.optional().nullable(),
  })
  .passthrough();

export type CreateRunResponse = z.infer<typeof CreateRunResponseSchema>;
export type RunDetail = z.infer<typeof RunDetailSchema>;
export type ToolExecutionSnapshot = z.infer<typeof ToolExecutionSnapshotSchema>;
export type PersistedAgentEvent = z.infer<typeof PersistedAgentEventSchema>;
export type ConversationEventsResponse = z.infer<typeof ConversationEventsResponseSchema>;
