/**
 * MCP tool argument/parameter validation.
 *
 * A deliberately small JSON Schema subset (type, required, properties,
 * additionalProperties:false, enum, nested object/array — no $ref/allOf) plus
 * the description sanitiser and the tool-facing argument error shape.
 */

import { Type } from 'typebox';
import { MCP_TOOL_DESCRIPTION_MAX_CHARS, PiMcpAdapterError } from './mcp-constants.js';
import { redactInlineSecrets } from '../../lib/event-redaction.js';

/**
 * Lightweight JSON Schema subset validation for MCP tool args (A4).
 * Supports type, required, properties, additionalProperties:false, enum,
 * and nested object/array. Intentionally small — no $ref / allOf.
 *
 * @param {unknown} schema
 * @param {unknown} value
 * @param {string} [path]
 */
export function assertMcpToolArgsAgainstSchema(schema, value, path = 'args') {
  if (schema == null || typeof schema !== 'object' || Array.isArray(schema)) {
    return;
  }
  const s = /** @type {Record<string, unknown>} */ (schema);
  const types = s.type == null ? null : Array.isArray(s.type) ? s.type : [s.type];
  if (types) {
    const ok = types.some((t) => {
      if (t === 'object') return value != null && typeof value === 'object' && !Array.isArray(value);
      if (t === 'array') return Array.isArray(value);
      if (t === 'string') return typeof value === 'string';
      if (t === 'number') return typeof value === 'number' && Number.isFinite(value);
      if (t === 'integer') return typeof value === 'number' && Number.isInteger(value);
      if (t === 'boolean') return typeof value === 'boolean';
      if (t === 'null') return value === null;
      return true;
    });
    if (!ok) {
      throw new PiMcpAdapterError(`${path} does not match inputSchema type`, {
        code: 'MCP_TOOL_ARGUMENTS_INVALID',
      });
    }
  }
  if (Array.isArray(s.enum) && !s.enum.includes(value)) {
    throw new PiMcpAdapterError(`${path} is not an allowed enum value`, {
      code: 'MCP_TOOL_ARGUMENTS_INVALID',
    });
  }
  if (value != null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = /** @type {Record<string, unknown>} */ (value);
    const required = Array.isArray(s.required) ? s.required : [];
    for (const key of required) {
      if (!(String(key) in obj)) {
        throw new PiMcpAdapterError(`${path}.${key} is required`, {
          code: 'MCP_TOOL_ARGUMENTS_INVALID',
        });
      }
    }
    const properties =
      s.properties != null && typeof s.properties === 'object' && !Array.isArray(s.properties)
        ? /** @type {Record<string, unknown>} */ (s.properties)
        : null;
    if (properties) {
      for (const [key, child] of Object.entries(properties)) {
        if (key in obj) {
          assertMcpToolArgsAgainstSchema(child, obj[key], `${path}.${key}`);
        }
      }
      if (s.additionalProperties === false) {
        for (const key of Object.keys(obj)) {
          if (!(key in properties)) {
            throw new PiMcpAdapterError(`${path}.${key} is not allowed`, {
              code: 'MCP_TOOL_ARGUMENTS_INVALID',
            });
          }
        }
      }
    }
  }
  if (Array.isArray(value) && s.items != null) {
    for (let i = 0; i < value.length; i += 1) {
      assertMcpToolArgsAgainstSchema(s.items, value[i], `${path}[${i}]`);
    }
  }
}

/**
 * Project a discovered MCP inputSchema as model-facing tool parameters.
 * TypeBox builders are JSON Schema objects; Pi also accepts a plain schema.
 * Unknown/empty schemas stay an open object so we do not invent fields.
 *
 * @param {unknown} inputSchema
 */
export function normalizeMcpToolParameters(inputSchema) {
  if (inputSchema == null || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) {
    return Type.Object({}, { additionalProperties: true });
  }
  const { $schema, ...normalized } = /** @type {Record<string, unknown>} */ ({
    .../** @type {Record<string, unknown>} */ (inputSchema),
  });
  void $schema;
  if (normalized.type == null && normalized.properties != null) {
    normalized.type = 'object';
  }
  if (normalized.type == null && normalized.properties == null) {
    return Type.Object({}, { additionalProperties: true });
  }
  return normalized;
}

/**
 * @param {unknown} raw
 * @param {string} fallback
 */
export function sanitizeMcpToolDescription(raw, fallback) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  const source = text || String(fallback || '').trim();
  return redactInlineSecrets(source).slice(0, MCP_TOOL_DESCRIPTION_MAX_CHARS);
}

/**
 * Argument-shape failures are certain (the MCP server was not invoked).
 * Return an isError tool result so approved replay can continue the run.
 *
 * @param {string} message
 */
export function mcpToolArgumentError(message) {
  const safe = redactInlineSecrets(String(message ?? 'invalid arguments')).slice(0, 512);
  return {
    content: [{ type: 'text', text: `Error [MCP_TOOL_ARGUMENTS_INVALID]: ${safe}` }],
    details: { code: 'MCP_TOOL_ARGUMENTS_INVALID' },
    isError: true,
  };
}
