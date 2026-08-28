/**
 * Model-facing shaping for ls / find / grep results.
 *
 * The Sandbox already applies its own budgets and reports `truncated` plus a
 * `stopReason`. This layer keeps the envelope small and, crucially, keeps the
 * truncation visible: a silently shortened result would have the model believe
 * it had seen everything and stop looking.
 */

import { toolResultJson } from '../result.js';
import { MAX_SEARCH_RESULT_BYTES } from '../constants.js';

/** Fields worth spending model context on, in the order a reader wants them. */
function projectItem(item) {
  const out = {
    path: item?.path ?? '',
    type: item?.type ?? 'file',
  };
  if (typeof item?.size === 'number' && item.size > 0) out.size = item.size;
  return out;
}

function projectMatch(match, outputMode) {
  if (outputMode === 'files_with_matches') {
    return { path: match?.path ?? '', line: match?.line ?? 0 };
  }
  if (outputMode === 'count') {
    return { path: match?.path ?? '', count: match?.count ?? 0 };
  }
  const out = {
    path: match?.path ?? '',
    line: match?.line ?? 0,
    text: typeof match?.text === 'string' ? match.text : '',
  };
  if (typeof match?.column === 'number' && match.column > 1) {
    out.column = match.column;
  }
  if (Array.isArray(match?.before) && match.before.length) out.before = match.before;
  if (Array.isArray(match?.after) && match.after.length) out.after = match.after;
  return out;
}

/**
 * A next step the model can actually take, rather than a bare `truncated: true`.
 * @param {string} tool
 * @param {string | null | undefined} stopReason
 */
function narrowHint(tool, stopReason) {
  if (tool === 'ls') {
    return 'Listing was cut short. Narrow it with a deeper path or a smaller depth.';
  }
  if (tool === 'find') {
    return 'More files match than were returned. Narrow the pattern or search a subdirectory.';
  }
  return stopReason === 'file_limit'
    ? 'More files contain matches than were returned. Add a glob to narrow the search.'
    : 'More matches exist than were returned. Make the query more specific or add a glob.';
}

/**
 * @param {'ls' | 'find'} tool
 * @param {any} data
 * @param {string} path
 */
export function formatListResult(tool, data, path) {
  const items = Array.isArray(data?.items) ? data.items.map(projectItem) : [];
  const payload = {
    tool,
    path,
    count: items.length,
    items,
  };
  const stats = data?.stats;
  if (stats && typeof stats.scanned === 'number' && stats.scanned > items.length) {
    payload.scanned = stats.scanned;
  }
  // Directories skipped for depth/permission reasons are part of the answer:
  // without them "not found" is indistinguishable from "never looked".
  const skipped = Array.isArray(data?.skipped) ? data.skipped : [];
  if (skipped.length) {
    payload.skipped = skipped.slice(0, 20).map((entry) => ({
      path: entry?.path ?? '',
      reason: entry?.reason ?? 'skipped',
    }));
  }
  if (data?.truncated) {
    payload.truncated = true;
    if (data.stop_reason || data.stopReason) {
      payload.stopReason = data.stop_reason ?? data.stopReason;
    }
    payload.hint = narrowHint(tool, payload.stopReason);
  }
  if (!items.length && !payload.truncated) {
    payload.hint =
      tool === 'ls'
        ? 'Nothing at that path. Check the path, or list its parent first.'
        : 'No file matched that pattern. Try a broader pattern or a different root.';
  }
  return toolResultJson(payload, MAX_SEARCH_RESULT_BYTES);
}

/**
 * @param {any} data
 * @param {string} path
 * @param {string} query
 * @param {'content' | 'files_with_matches' | 'count'} [outputMode]
 */
export function formatGrepResult(data, path, query, outputMode = 'content') {
  const matches = Array.isArray(data?.matches)
    ? data.matches.map((m) => projectMatch(m, outputMode))
    : [];
  const payload = {
    tool: 'grep',
    path,
    query,
    outputMode,
    count: matches.length,
    matches,
  };
  const stats = data?.stats;
  if (stats && typeof stats.scanned === 'number') payload.filesScanned = stats.scanned;
  const files = new Set(matches.map((m) => m.path).filter(Boolean));
  if (files.size) payload.filesMatched = files.size;
  const skipped = Array.isArray(data?.skipped) ? data.skipped : [];
  if (skipped.length) {
    payload.skipped = skipped.slice(0, 20).map((entry) => ({
      path: entry?.path ?? '',
      reason: entry?.reason ?? 'skipped',
    }));
  }
  if (data?.truncated) {
    payload.truncated = true;
    if (data.stop_reason || data.stopReason) {
      payload.stopReason = data.stop_reason ?? data.stopReason;
    }
    payload.hint = narrowHint('grep', payload.stopReason);
  }
  if (!matches.length && !payload.truncated) {
    payload.hint =
      'No match. Check the spelling, try regex:true for a pattern, or widen the path.';
  }
  return toolResultJson(payload, MAX_SEARCH_RESULT_BYTES);
}
