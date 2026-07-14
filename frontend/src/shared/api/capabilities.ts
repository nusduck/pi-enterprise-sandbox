/**
 * Capability registry API adapters (F5 / ADR 0003 §11).
 * Soft-fail when BFF has not yet proxied MCP/model/skill registry endpoints.
 */
import {
  McpServerListSchema,
  McpServerSchema,
  ModelItemSchema,
  ModelListSchema,
  SkillItemSchema,
  SkillListSchema,
  ToolRegistryItemSchema,
  ToolRegistrySchema,
  type McpServerItem,
  type ModelItem,
  type SkillItem,
  type ToolRegistryItem,
} from '../schemas/management';
import { parseApi } from '../schemas/api';
import { authHeaders } from './client';

export type { McpServerItem, ModelItem, SkillItem, ToolRegistryItem };

export type ExtensionDiagnostics = {
  status: string;
  generated_at: string;
  profile: {
    id: string;
    version: string;
    extensions: string[];
    allowed_tools: string[];
    allowed_mcp_servers: string[];
    skills: string[];
    context_policy: Record<string, unknown>;
  };
  package: { package: string; version: string; audit?: { status?: string } };
  mcp_servers: Array<{ server_id: string; connection_status: string }>;
};

const BASE = '/api';

/** Result with soft-fail metadata so UI can show "backend incomplete" empty states. */
export type SoftListResult<T> = {
  items: T[];
  available: boolean;
  error?: string | null;
};

async function softGet(
  path: string,
): Promise<{ ok: true; data: unknown } | { ok: false; available: boolean; error?: string }> {
  try {
    const resp = await fetch(`${BASE}${path}`, {
      headers: authHeaders(),
    });
    if (resp.status === 404 || resp.status === 501 || resp.status === 405) {
      return { ok: false, available: false };
    }
    if (!resp.ok) {
      return {
        ok: false,
        available: true,
        error: `HTTP ${resp.status}`,
      };
    }
    return { ok: true, data: await resp.json() };
  } catch (err) {
    return {
      ok: false,
      available: false,
      error: (err as Error).message,
    };
  }
}

export async function getExtensionDiagnostics(): Promise<ExtensionDiagnostics | null> {
  const res = await softGet('/extensions/diagnostics');
  return res.ok ? (res.data as ExtensionDiagnostics) : null;
}

function unwrapArray(data: unknown, keys: string[]): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    for (const k of keys) {
      if (Array.isArray(obj[k])) return obj[k] as unknown[];
    }
  }
  return [];
}

/**
 * GET /api/capabilities/skills
 */
export async function listSkills(): Promise<SoftListResult<SkillItem>> {
  const res = await softGet('/capabilities/skills');
  if (!res.ok) return { items: [], available: res.available, error: res.error };
  parseApi(SkillListSchema, res.data, 'listSkills');
  const items = unwrapArray(res.data, ['skills']).map((item) =>
    parseApi(SkillItemSchema, item, 'listSkills.item'),
  );
  return { items, available: true };
}

/**
 * GET /api/capabilities/mcp
 */
export async function listMcpServers(): Promise<SoftListResult<McpServerItem>> {
  const res = await softGet('/capabilities/mcp');
  if (!res.ok) return { items: [], available: res.available, error: res.error };
  parseApi(McpServerListSchema, res.data, 'listMcpServers');
  const items = unwrapArray(res.data, ['servers']).map((item) =>
    parseApi(McpServerSchema, item, 'listMcpServers.item'),
  );
  return { items, available: true };
}

/**
 * GET /api/capabilities/tools
 */
export async function listTools(): Promise<SoftListResult<ToolRegistryItem>> {
  const res = await softGet('/capabilities/tools');
  if (!res.ok) return { items: [], available: res.available, error: res.error };
    parseApi(ToolRegistrySchema, res.data, 'listTools');
    const data = res.data;
    if (data && typeof data === 'object') {
      const obj = data as {
        tools?: unknown[] | Record<string, unknown[]>;
        allowlist?: string[];
      };
      if (Array.isArray(obj.tools)) {
        return {
          items: obj.tools.map((t) =>
            parseApi(ToolRegistryItemSchema, t, 'listTools.item'),
          ),
          available: true,
        };
      }
      if (obj.tools && typeof obj.tools === 'object' && !Array.isArray(obj.tools)) {
        const flat: ToolRegistryItem[] = [];
        for (const [category, list] of Object.entries(obj.tools)) {
          if (!Array.isArray(list)) continue;
          for (const t of list) {
            flat.push(
              parseApi(
                ToolRegistryItemSchema,
                { ...(typeof t === 'object' && t ? t : { name: String(t) }), category },
                'listTools.item',
              ),
            );
          }
        }
        return { items: flat, available: true };
      }
      if (Array.isArray(obj.allowlist)) {
        return {
          items: obj.allowlist.map((name) =>
            parseApi(ToolRegistryItemSchema, { name, enabled: true }, 'listTools.item'),
          ),
          available: true,
        };
      }
    }
    const items = unwrapArray(data, ['tools']).map((item) =>
      parseApi(ToolRegistryItemSchema, item, 'listTools.item'),
    );
  return { items, available: true };
}

/**
 * GET /api/capabilities/models
 */
export async function listModels(): Promise<SoftListResult<ModelItem>> {
  const res = await softGet('/capabilities/models');
  if (!res.ok) return { items: [], available: res.available, error: res.error };
  parseApi(ModelListSchema, res.data, 'listModels');
  const items = unwrapArray(res.data, ['models']).map((item) =>
    parseApi(ModelItemSchema, item, 'listModels.item'),
  );
  return { items, available: true };
}
