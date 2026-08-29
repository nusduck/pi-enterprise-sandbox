/**
 * tools/post-execute：无条件脱敏 + 账本摘要。
 *
 * 裸 Error 也走 toWireError，不能只对 FsError 脱敏。
 */

import { toWireError, type WireError } from '@pi/contract/errors.js';

export interface LedgerEntry {
  readonly callId: string;
  readonly toolName: string;
  readonly ok: boolean;
  readonly error?: WireError;
}

export function redactPostExecute(
  err: unknown,
  physicalRoots: readonly string[],
): WireError {
  return toWireError(err, { physicalRoots });
}

export function recordLedger(entry: {
  callId: string;
  toolName: string;
  ok: boolean;
  error?: unknown;
  physicalRoots: readonly string[];
}): LedgerEntry {
  if (entry.ok || entry.error === undefined) {
    return { callId: entry.callId, toolName: entry.toolName, ok: entry.ok };
  }
  return {
    callId: entry.callId,
    toolName: entry.toolName,
    ok: false,
    error: redactPostExecute(entry.error, entry.physicalRoots),
  };
}
