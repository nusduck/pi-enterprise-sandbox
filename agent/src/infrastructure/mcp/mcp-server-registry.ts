/**
 * Deployment MCP server registry (MCP_SERVERS_JSON) parsing.
 *
 * Pure, fail-closed normalisation of operator-supplied server definitions into
 * frozen records: id/transport/url shape, header and env reference maps, and the
 * reserved trace bindings an operator may not override. No I/O and no adapter
 * import — connecting to the servers is the factory's job.
 */

import {
  ENV_NAME_PATTERN,
  HEADER_NAME_PATTERN,
  MCP_TRANSPORT_VALUES,
  PiMcpAdapterError,
  SENSITIVE_QUERY_KEY,
  SERVER_ID_PATTERN,
} from './mcp-constants.js';

/**
 * @param raw
 * @returns {unknown[]}
 */
function parseRegistryInput(raw: unknown) {
  if (raw == null || raw === '') return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('must be an array');
      return parsed;
    } catch (error) {
      throw new PiMcpAdapterError('MCP_SERVERS_JSON must be valid JSON array', {
        code: 'MCP_SERVER_REGISTRY_INVALID',
        cause: error,
      });
    }
  }
  throw new PiMcpAdapterError('MCP server registry must be an array or JSON array', {
    code: 'MCP_SERVER_REGISTRY_INVALID',
  });
}

function parseReferenceMap(raw: unknown, field: string, keyPattern: RegExp) {
  if (raw == null) return Object.freeze({});
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PiMcpAdapterError(`${field} must be an object of secret references`, {
      code: 'MCP_SERVER_REGISTRY_INVALID',
    });
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const ref = String(value ?? '').trim();
    if (!keyPattern.test(key) || !ref) {
      throw new PiMcpAdapterError(`${field} contains an invalid key or secret reference`, {
        code: 'MCP_SERVER_REGISTRY_INVALID',
      });
    }
    out[key] = ref;
  }
  return Object.freeze(out);
}

export type McpServerRecord = {
  serverId: string;
  enabled: boolean;
  url: string | null;
  command: string | null;
  args: readonly string[];
  cwd: string | null;
  auth: unknown;
  authTokenRef: string | null;
  envRefs: Readonly<Record<string, string>>;
  headerRefs: Readonly<Record<string, string>>;
  timeoutMs: number | null;
  transport: string | null;
};

/**
 * Validate the deployment-owned MCP registry. Plaintext credential-bearing
 * fields are rejected; values must be referenced through authTokenRef,
 * envRefs, or headerRefs.
 *
 * @param raw
 * @returns {Map<string, McpServerRecord>}
 */
export function loadMcpServerRegistry(raw: unknown) {
  const entries = parseRegistryInput(raw);
  const registry = new Map();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new PiMcpAdapterError(`MCP_SERVERS_JSON[${index}] must be an object`, {
        code: 'MCP_SERVER_REGISTRY_INVALID',
      });
    }
    const value = (entry as Record<string, unknown>);
    const serverId = String(value.id ?? value.serverId ?? '').trim();
    if (!SERVER_ID_PATTERN.test(serverId)) {
      throw new PiMcpAdapterError(`MCP_SERVERS_JSON[${index}].id is invalid`, {
        code: 'MCP_SERVER_REGISTRY_INVALID',
      });
    }
    if (registry.has(serverId)) {
      throw new PiMcpAdapterError(`duplicate MCP server registry id: ${serverId}`, {
        code: 'MCP_SERVER_REGISTRY_INVALID',
      });
    }
    for (const forbidden of [
      'token',
      'authToken',
      'bearerToken',
      'apiKey',
      'password',
      'secret',
      'headers',
      'env',
    ]) {
      if (Object.hasOwn(value, forbidden)) {
        throw new PiMcpAdapterError(
          `MCP_SERVERS_JSON[${index}].${forbidden} must not contain plaintext credentials; use a *Ref field`,
          { code: 'MCP_PLAINTEXT_SECRET_FORBIDDEN' },
        );
      }
    }

    const url = value.url == null ? null : String(value.url).trim();
    const command = value.command == null ? null : String(value.command).trim();
    if ((url ? 1 : 0) + (command ? 1 : 0) !== 1) {
      throw new PiMcpAdapterError(
        `MCP server ${serverId} must configure exactly one of url or command`,
        { code: 'MCP_SERVER_REGISTRY_INVALID' },
      );
    }
    if (url) {
      let parsed;
      try {
        parsed = new URL(url);
      } catch (error) {
        throw new PiMcpAdapterError(`MCP server ${serverId} has an invalid URL`, {
          code: 'MCP_SERVER_REGISTRY_INVALID',
          cause: error,
        });
      }
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
        throw new PiMcpAdapterError(
          `MCP server ${serverId} URL must be http(s) and must not embed credentials`,
          { code: 'MCP_SERVER_REGISTRY_INVALID' },
        );
      }
      for (const key of parsed.searchParams.keys()) {
        if (SENSITIVE_QUERY_KEY.test(key)) {
          throw new PiMcpAdapterError(
            `MCP server ${serverId} URL must not embed credential query parameters`,
            { code: 'MCP_PLAINTEXT_SECRET_FORBIDDEN' },
          );
        }
      }
    }

    const args = value.args == null ? [] : value.args;
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
      throw new PiMcpAdapterError(`MCP server ${serverId}.args must be strings`, {
        code: 'MCP_SERVER_REGISTRY_INVALID',
      });
    }
    const authTokenRef =
      value.authTokenRef == null ? null : String(value.authTokenRef).trim();
    if (authTokenRef === '') {
      throw new PiMcpAdapterError(`MCP server ${serverId}.authTokenRef is empty`, {
        code: 'MCP_SERVER_REGISTRY_INVALID',
      });
    }
    const auth = value.auth == null ? null : value.auth;
    if (auth !== null && auth !== false && !['bearer', 'oauth'].includes(String(auth))) {
      throw new PiMcpAdapterError(`MCP server ${serverId}.auth is invalid`, {
        code: 'MCP_SERVER_REGISTRY_INVALID',
      });
    }

    const timeoutMs = value.timeoutMs == null ? null : Number(value.timeoutMs);
    if (
      timeoutMs !== null &&
      (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000)
    ) {
      throw new PiMcpAdapterError(
        `MCP server ${serverId}.timeoutMs must be 1000..300000`,
        { code: 'MCP_SERVER_REGISTRY_INVALID' },
      );
    }

    // transport is advisory for http(s) servers. Vendor adapter probes
    // streamable-http first then SSE; we retain the declared preference so
    // discovery retries can prefer re-probing streamable over caching a
    // transient SSE 405 as a permanent failure.
    let transport = null;
    if (value.transport != null && String(value.transport).trim() !== '') {
      transport = String(value.transport).trim().toLowerCase();
      if (!MCP_TRANSPORT_VALUES.includes(transport)) {
        throw new PiMcpAdapterError(
          `MCP server ${serverId}.transport must be one of ${MCP_TRANSPORT_VALUES.join(', ')}`,
          { code: 'MCP_SERVER_REGISTRY_INVALID' },
        );
      }
      if (!url && transport) {
        throw new PiMcpAdapterError(
          `MCP server ${serverId}.transport is only valid for url servers`,
          { code: 'MCP_SERVER_REGISTRY_INVALID' },
        );
      }
    } else if (url) {
      transport = 'auto';
    }

    registry.set(
      serverId,
      Object.freeze({
        serverId,
        enabled: value.enabled !== false,
        url,
        command,
        args: Object.freeze([...args]),
        cwd: value.cwd == null ? null : String(value.cwd).trim() || null,
        auth,
        authTokenRef,
        envRefs: parseReferenceMap(value.envRefs, `${serverId}.envRefs`, ENV_NAME_PATTERN),
        headerRefs: parseReferenceMap(
          value.headerRefs,
          `${serverId}.headerRefs`,
          HEADER_NAME_PATTERN,
        ),
        timeoutMs,
        transport,
      }),
    );
  }
  return registry;
}
