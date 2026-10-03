import type { EntityStore } from '../../../entities';
import type { RunSSEManager } from '../../../shared/sse/manager';
import { getRunTraceSpans as fetchRunTraceSpans } from '../../../shared/api/runs';
import type { RunTraceResponse } from '../../../shared/schemas/events';
import { rehydrateTraceSpans, sameRunRevision } from '../entityProjections';

const MAX_TRACE_PAGES = 100;

export async function fetchDurableTrace(
  runId: string,
  expectedTraceId: string | null | undefined,
): Promise<RunTraceResponse | null> {
  // Older BFFs may omit trace_id from Run detail. Avoid a speculative request
  // in that compatibility case; live spans remain available from SSE replay.
  if (!expectedTraceId) return null;
  let page = await fetchRunTraceSpans(runId);
  const firstTraceId = page.traceId || page.trace_id || null;
  if (firstTraceId && firstTraceId !== expectedTraceId) {
    throw new Error('trace response changed trace id');
  }
  const firstRunId = page.runId || page.run_id || null;
  if (firstRunId && firstRunId !== runId) {
    throw new Error('trace response changed run id');
  }
  const aggregate: RunTraceResponse = {
    ...page,
    spans: [...page.spans],
    truncated: page.truncated === true,
    nextCursor: page.nextCursor ?? page.next_cursor ?? null,
    next_cursor: page.next_cursor ?? page.nextCursor ?? null,
  };
  const seenCursors = new Set<string>();
  let pageCount = 1;
  while (
    aggregate.truncated === true &&
    aggregate.nextCursor &&
    pageCount < MAX_TRACE_PAGES
  ) {
    const cursor = String(aggregate.nextCursor);
    if (seenCursors.has(cursor)) break;
    seenCursors.add(cursor);
    page = await fetchRunTraceSpans(runId, { cursor });
    const pageTraceId = page.traceId || page.trace_id || null;
    const aggregateTraceId = aggregate.traceId || aggregate.trace_id || null;
    if (pageTraceId && aggregateTraceId && pageTraceId !== aggregateTraceId) {
      throw new Error('trace page changed trace id');
    }
    const pageRunId = page.runId || page.run_id || null;
    const aggregateRunId = aggregate.runId || aggregate.run_id || null;
    if (pageRunId && aggregateRunId && pageRunId !== aggregateRunId) {
      throw new Error('trace page changed run id');
    }
    aggregate.spans.push(...page.spans);
    aggregate.truncated = page.truncated === true;
    aggregate.nextCursor = page.nextCursor ?? page.next_cursor ?? null;
    aggregate.next_cursor = aggregate.nextCursor;
    pageCount += 1;
  }
  // A hard page ceiling is an honest partial result, not permission to clear
  // the live tree. The response schema exposes this state to the rehydrator.
  if (aggregate.truncated && pageCount >= MAX_TRACE_PAGES) {
    aggregate.nextCursor = aggregate.nextCursor || null;
    aggregate.next_cursor = aggregate.nextCursor;
  }
  return aggregate;
}

export async function loadDurableTrace(
  manager: RunSSEManager,
  next: EntityStore,
  runId: string,
): Promise<EntityStore> {
  const expectedRun = next.runsById[runId];
  const response = await fetchDurableTrace(
    runId,
    expectedRun?.traceId,
  );
  const latest = manager.getStore();
  const currentRun = latest.runsById[runId];
  if (!sameRunRevision(expectedRun, currentRun)) return latest;
  // Rebase the target Run's trace projection onto the latest global store so
  // an unrelated background Run cannot be rolled back by this HTTP request.
  return response ? rehydrateTraceSpans(latest, runId, response) : latest;
}
