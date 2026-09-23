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
