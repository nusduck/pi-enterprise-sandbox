/** Build a complete, chronologically ordered persisted conversation timeline. */
export async function loadConversationTimeline(client, conversationId, { limit } = {}) {
  const runs = await client.listAgentRuns({ conversationId });
  const chronologicalRuns = [...runs].sort((a, b) =>
    String(a.created_at || '').localeCompare(String(b.created_at || '')),
  );
  const eventGroups = await Promise.all(
    chronologicalRuns.map(async (run) => ({
      run,
      events: await client.listAgentEvents(run.run_id, { limit }),
    })),
  );
  return {
    runs: chronologicalRuns,
    events: eventGroups.flatMap(({ events }) => events),
    last_run: chronologicalRuns.at(-1) || null,
  };
}
