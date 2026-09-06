/**
 * The model-facing MCP tool name used by `@deepseek-ai/dsh-mcp-client`.
 *
 * MCP identities are `(serverName, rawName)`.  The public name is only a
 * projection of that identity; callers must never split the public string to
 * recover either component because both names may contain `__` and lossy
 * normalization is hashed.
 */

import { createHash } from 'node:crypto';

const MAX_PUBLIC_NAME_LENGTH = 64;
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g;
const HASH_LENGTH = 12;

/** Keep this byte-for-byte compatible with dsh-mcp-client's public function. */
export function publicMcpToolName(serverName: string, rawName: string): string {
  const joined = `mcp__${serverName}__${rawName}`;
  const normalized = joined.replace(INVALID_NAME_CHARS, '_');
  if (
    normalized === joined &&
    normalized.length <= MAX_PUBLIC_NAME_LENGTH
  ) {
    return normalized;
  }
  const hash = createHash('sha256')
    .update(`${serverName}\0${rawName}`)
    .digest('hex')
    .slice(0, HASH_LENGTH);
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`;
}

export interface McpPublicNameServer {
  readonly serverId: string;
  readonly enabledTools: readonly string[];
}

/**
 * Resolve a registered public name against known raw MCP identities.
 * Returning null is intentional: an unlisted live tool remains subject to the
 * platform fail-closed MCP policy and is not guessed from delimiters.
 */
export function resolveMcpPublicIdentity(
  publicName: string,
  servers: readonly McpPublicNameServer[],
): { serverId: string; toolName: string } | null {
  for (const server of servers) {
    for (const toolName of server.enabledTools) {
      if (publicMcpToolName(server.serverId, toolName) === publicName) {
        return { serverId: server.serverId, toolName };
      }
    }
  }
  return null;
}
