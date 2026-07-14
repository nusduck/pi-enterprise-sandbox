/**
 * Zod schemas for API Server resources.
 * Wire format remains snake_case; UI maps to camelCase where needed.
 */
import { z } from 'zod';

export const AuthUserSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    username: z.string(),
    display_name: z.string().optional().nullable(),
  })
  .passthrough();

export const AuthResponseSchema = z
  .object({
    user: AuthUserSchema.optional(),
  });

export const MeResponseSchema = AuthUserSchema;

export const ConversationSchema = z
  .object({
    id: z.string(),
    title: z.string().optional().nullable(),
    created_at: z.string().optional().nullable(),
    updated_at: z.string().optional().nullable(),
    sandbox_session_id: z.string().optional().nullable(),
    messages: z.array(z.unknown()).optional(),
  })
  .passthrough();

export const ConversationListSchema = z.array(ConversationSchema);

export const ConversationDetailSchema = ConversationSchema;

export const EnsureSessionSchema = z
  .object({
    conversation_id: z.string(),
    session_id: z.string(),
    workspace_id: z.string().optional().nullable(),
    trace_id: z.string().optional().nullable(),
  })
  .passthrough();

export const ArtifactSchema = z
  .object({
    artifact_id: z.string().optional(),
    id: z.string().optional(),
    name: z.string().optional().nullable(),
    path: z.string().optional().nullable(),
    size: z.number().optional().nullable(),
    mime_type: z.string().optional().nullable(),
  })
  .passthrough();

export const ArtifactListSchema = z.union([
  z.array(ArtifactSchema),
  z
    .object({
      artifacts: z.array(ArtifactSchema).optional(),
      total: z.number().optional(),
    })
    .passthrough(),
]);

export const UploadResponseSchema = z
  .object({
    attachment_id: z.string().optional(),
    attachmentId: z.string().optional(),
    path: z.string().optional().nullable(),
    size: z.number().optional().nullable(),
    trace_id: z.string().optional().nullable(),
  })
  .passthrough();

export const ApprovalDecisionSchema = z
  .object({
    ok: z.boolean().optional(),
    status: z.string().optional(),
  })
  .passthrough();

export const StatusSchema = z
  .object({
    status: z.string().optional(),
    ok: z.boolean().optional(),
  })
  .passthrough();

/** Loose SSE event envelope — unknown types are ignored by the handler. */
export const SSEEventSchema = z
  .object({
    type: z.string(),
  })
  .passthrough();

// Re-export runtime event schemas for convenience
export {
  RuntimeEventSchema,
  parseRuntimeEvent,
  makeRuntimeEvent,
  RUNTIME_EVENT_TYPES,
  CreateRunResponseSchema,
  RunDetailSchema,
  ConversationEventsResponseSchema,
} from './events';
export type {
  RuntimeEvent,
  RuntimeEventType,
  CreateRunResponse,
  RunDetail,
  PersistedAgentEvent,
  ConversationEventsResponse,
} from './events';

export type AuthUser = z.infer<typeof AuthUserSchema>;
export type AuthResponse = z.infer<typeof AuthResponseSchema>;
export type Conversation = z.infer<typeof ConversationSchema>;
export type EnsureSession = z.infer<typeof EnsureSessionSchema>;
export type Artifact = z.infer<typeof ArtifactSchema>;
export type UploadResponse = z.infer<typeof UploadResponseSchema>;

/**
 * Parse with Zod; on failure return fallback / throw controlled error.
 * Keeps UI resilient when backend adds optional fields.
 */
export function parseApi<T>(
  schema: z.ZodType<T>,
  data: unknown,
  label = 'API response',
): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    console.warn(`[schema] ${label} validation failed:`, result.error.issues);
    // Soft-fail: return original data cast when structure is close enough for UI
    return data as T;
  }
  return result.data;
}

/** Strict parser for core contracts where silently accepting drift is unsafe. */
export function parseApiStrict<T>(
  schema: z.ZodType<T>,
  data: unknown,
  label = 'API response',
): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new Error(
      `${label} contract mismatch: ${result.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return result.data;
}
