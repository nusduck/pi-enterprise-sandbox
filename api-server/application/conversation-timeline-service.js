/**
 * Build a complete, chronologically ordered persisted conversation timeline.
 *
 * PR-13: Agent MySQL is the sole Run/event fact source. Callers must pass a
 * client that talks to Agent (listAgentRuns + listAgentEvents), never Sandbox
 * /agent-runs dual ledger.
 *
 * @param {{
 *   listAgentRuns: (q: { conversationId: string }) => Promise<object[]|object>,
 *   listAgentEvents: (runId: string, q?: object) => Promise<object[]>,
 * }} client
 * @param {string} conversationId
 * @param {{ limit?: number }} [opts]
 */
export async function loadConversationTimeline(client, conversationId, { limit } = {}) {
  const listed = await client.listAgentRuns({ conversationId });
  const runs = Array.isArray(listed)
    ? listed
    : Array.isArray(listed?.runs)
      ? listed.runs
      : [];
  const chronologicalRuns = [...runs].sort((a, b) =>
    String(a.created_at || a.createdAt || '').localeCompare(
      String(b.created_at || b.createdAt || ''),
    ),
  );
  const eventGroups = await Promise.all(
    chronologicalRuns.map(async (run) => {
      const runId = run.run_id || run.runId || run.id;
      const events = runId
        ? await client.listAgentEvents(runId, { limit })
        : [];
      return {
        run,
        events: Array.isArray(events) ? events : [],
      };
    }),
  );
  return {
    runs: chronologicalRuns,
    events: eventGroups.flatMap(({ events }) => events),
    last_run: chronologicalRuns.at(-1) || null,
  };
}
