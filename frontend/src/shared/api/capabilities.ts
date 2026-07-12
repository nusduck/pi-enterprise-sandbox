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
 * GET /api/skills or /api/capabilities/skills
 * Tries both paths; soft-fails to empty.
 */
export async function listSkills(): Promise<SoftListResult<SkillItem>> {
  for (const path of ['/skills', '/capabilities/skills']) {
    const res = await softGet(path);
    if (!res.ok) {
      if (res.available === false) continue;
      return { items: [], available: true, error: res.error };
    }
    parseApi(SkillListSchema, res.data, 'listSkills');
    const items = unwrapArray(res.data, ['skills']).map((item) =>
      parseApi(SkillItemSchema, item, 'listSkills.item'),
    );
    return { items, available: true };
  }
  return { items: [], available: false };
}

/**
 * GET /api/mcp/servers or /api/capabilities/mcp
 */
export async function listMcpServers(): Promise<SoftListResult<McpServerItem>> {
  for (const path of ['/mcp/servers', '/capabilities/mcp', '/mcp/registry']) {
    const res = await softGet(path);
    if (!res.ok) {
      if (res.available === false) continue;
      return { items: [], available: true, error: res.error };
    }
    // /mcp/registry returns tools tree — treat as available but extract servers if present
    if (path === '/mcp/registry') {
      parseApi(ToolRegistrySchema, res.data, 'mcpRegistry');
      const servers = unwrapArray(res.data, ['servers']);
      if (servers.length === 0) {
        return { items: [], available: true };
      }
      return {
        items: servers.map((s) =>
          parseApi(McpServerSchema, s, 'listMcpServers.item'),
        ),
        available: true,
      };
    }
    parseApi(McpServerListSchema, res.data, 'listMcpServers');
    const items = unwrapArray(res.data, ['servers']).map((item) =>
      parseApi(McpServerSchema, item, 'listMcpServers.item'),
    );
    return { items, available: true };
  }
  return { items: [], available: false };
}

/**
 * GET /api/mcp/registry or /api/tools or /api/capabilities/tools
 */
export async function listTools(): Promise<SoftListResult<ToolRegistryItem>> {
  for (const path of ['/mcp/registry', '/tools', '/capabilities/tools']) {
    const res = await softGet(path);
    if (!res.ok) {
      if (res.available === false) continue;
      return { items: [], available: true, error: res.error };
    }
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
  return { items: [], available: false };
}

/**
 * GET /api/models or /api/capabilities/models
 */
export async function listModels(): Promise<SoftListResult<ModelItem>> {
  for (const path of ['/models', '/capabilities/models']) {
    const res = await softGet(path);
    if (!res.ok) {
      if (res.available === false) continue;
      return { items: [], available: true, error: res.error };
    }
    parseApi(ModelListSchema, res.data, 'listModels');
    const items = unwrapArray(res.data, ['models']).map((item) =>
      parseApi(ModelItemSchema, item, 'listModels.item'),
    );
    return { items, available: true };
  }
  return { items: [], available: false };
}
