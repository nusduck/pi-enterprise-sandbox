/**
 * Zod schemas for management-page APIs (F5 / ADR 0003 §9–11).
 * Soft-fail friendly: passthrough + optional fields so incomplete backends don't crash UI.
 */
import { z } from 'zod';

// ── Runs list (GET /api/runs) ───────────────────

export const RunListItemSchema = z
  .object({
    id: z.string().optional(),
    run_id: z.string().optional(),
    conversation_id: z.string().optional().nullable(),
    session_id: z.string().optional().nullable(),
    agent_session_id: z.string().optional().nullable(),
    status: z.string().optional(),
    model_id: z.string().optional().nullable(),
    model: z.string().optional().nullable(),
    current_step: z.union([z.string(), z.number()]).optional().nullable(),
    current_tool: z.string().optional().nullable(),
    error: z.string().optional().nullable(),
    started_at: z.string().optional().nullable(),
    finished_at: z.string().optional().nullable(),
    created_at: z.string().optional().nullable(),
    usage: z.record(z.string(), z.unknown()).optional().nullable(),
    token_usage: z.record(z.string(), z.unknown()).optional().nullable(),
    runner: z.string().optional().nullable(),
  })
  .passthrough();

export const RunListSchema = z.union([
  z.array(RunListItemSchema),
  z
    .object({
      runs: z.array(RunListItemSchema).optional(),
      total: z.number().optional(),
    })
    .passthrough(),
]);

// ── Approvals list (GET /api/approvals) ─────────

export const ApprovalListItemSchema = z
  .object({
    id: z.string().optional(),
    approval_id: z.string().optional(),
    run_id: z.string().optional().nullable(),
    conversation_id: z.string().optional().nullable(),
    session_id: z.string().optional().nullable(),
    tool_name: z.string().optional().nullable(),
    tool: z.string().optional().nullable(),
    status: z.string().optional(),
    risk_level: z.string().optional().nullable(),
    reason: z.string().optional().nullable(),
    command: z.string().optional().nullable(),
    arguments: z.unknown().optional(),
    payload: z.record(z.string(), z.unknown()).optional().nullable(),
    workspace_id: z.string().optional().nullable(),
    user_id: z.union([z.string(), z.number()]).optional().nullable(),
    username: z.string().optional().nullable(),
    created_at: z.string().optional().nullable(),
    expires_at: z.string().optional().nullable(),
    decided_at: z.string().optional().nullable(),
  })
  .passthrough();

export const ApprovalListSchema = z.union([
  z.array(ApprovalListItemSchema),
  z
    .object({
      approvals: z.array(ApprovalListItemSchema).optional(),
      total: z.number().optional(),
    })
    .passthrough(),
]);

// ── Capabilities: Skills / MCP / Tools / Models ─

export const SkillItemSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    description: z.string().optional().nullable(),
    path: z.string().optional().nullable(),
    enabled: z.boolean().optional(),
    source: z.string().optional().nullable(),
  })
  .passthrough();

export const SkillListSchema = z.union([
  z.array(SkillItemSchema),
  z
    .object({
      skills: z.array(SkillItemSchema).optional(),
      total: z.number().optional(),
    })
    .passthrough(),
]);

export const McpServerSchema = z
  .object({
    server_id: z.string().optional(),
    id: z.string().optional(),
    name: z.string().optional().nullable(),
    status: z.string().optional().nullable(),
    connection_status: z.string().optional().nullable(),
    tools_count: z.number().optional().nullable(),
    tool_count: z.number().optional().nullable(),
    authorization: z.string().optional().nullable(),
    enabled: z.boolean().optional(),
    last_refresh: z.string().optional().nullable(),
    last_refreshed_at: z.string().optional().nullable(),
  })
  .passthrough();

export const McpServerListSchema = z.union([
  z.array(McpServerSchema),
  z
    .object({
      servers: z.array(McpServerSchema).optional(),
      total: z.number().optional(),
    })
    .passthrough(),
]);

export const ToolRegistryItemSchema = z
  .object({
    name: z.string().optional(),
    id: z.string().optional(),
    category: z.string().optional().nullable(),
    source: z.string().optional().nullable(),
    risk_level: z.string().optional().nullable(),
    approval_policy: z.string().optional().nullable(),
    timeout: z.union([z.number(), z.string()]).optional().nullable(),
    retry_policy: z.unknown().optional().nullable(),
    enabled: z.boolean().optional(),
    schema: z.unknown().optional(),
    description: z.string().optional().nullable(),
  })
  .passthrough();

export const ToolRegistrySchema = z.union([
  z.array(ToolRegistryItemSchema),
  z
    .object({
      tools: z.union([
        z.array(ToolRegistryItemSchema),
        z.record(z.string(), z.array(ToolRegistryItemSchema)),
      ]).optional(),
      categories: z.unknown().optional(),
      version: z.string().optional(),
      allowlist: z.array(z.string()).optional(),
    })
    .passthrough(),
]);

export const ModelItemSchema = z
  .object({
    model_id: z.string().optional(),
    id: z.string().optional(),
    provider: z.string().optional().nullable(),
    api_protocol: z.string().optional().nullable(),
    context_window: z.number().optional().nullable(),
    max_output_tokens: z.number().optional().nullable(),
    supports_tool_call: z.boolean().optional(),
    supports_reasoning: z.boolean().optional(),
    enabled: z.boolean().optional(),
    pricing: z.record(z.string(), z.unknown()).optional().nullable(),
  })
  .passthrough();

export const ModelListSchema = z.union([
  z.array(ModelItemSchema),
  z
    .object({
      models: z.array(ModelItemSchema).optional(),
      total: z.number().optional(),
    })
    .passthrough(),
]);

export type RunListItem = z.infer<typeof RunListItemSchema>;
export type ApprovalListItem = z.infer<typeof ApprovalListItemSchema>;
export type SkillItem = z.infer<typeof SkillItemSchema>;
export type McpServerItem = z.infer<typeof McpServerSchema>;
export type ToolRegistryItem = z.infer<typeof ToolRegistryItemSchema>;
export type ModelItem = z.infer<typeof ModelItemSchema>;
