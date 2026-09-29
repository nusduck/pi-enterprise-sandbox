/**
 * Builders for the wire shape the Agent really emits: BFF relay frames
 * `{ sequence, event: { type, event_id, data }, ts }` with dotted platform types
 * (see `fixtures/live-run-sse.json`, captured from a running stack).
 */
export type WireFrame = {
  sequence: number;
  event: Record<string, unknown>;
  ts: number;
  event_id: string;
};

export function frame(
  sequence: number,
  type: string,
  data: Record<string, unknown> = {},
  top: Record<string, unknown> = {},
): WireFrame {
  const event_id = `evt_${sequence}`;
  return { sequence, event: { type, event_id, data, ...top }, ts: 1_700_000_000_000 + sequence, event_id };
}

export const runStarted = (seq: number, top: Record<string, unknown> = {}) =>
  frame(seq, 'run.started', {}, { status: 'STARTING', ...top });

export const runCompleted = (seq: number) => frame(seq, 'run.completed', {}, { status: 'SUCCEEDED' });

export const runFailed = (seq: number, message: string) => frame(seq, 'run.failed', { message });

export const messageDelta = (seq: number, delta: string, messageId = 'assistant:seq1') =>
  frame(seq, 'message.delta', { role: 'assistant', delta, messageId });

export const messageCompleted = (seq: number, messageId = 'assistant:seq1') =>
  frame(seq, 'message.completed', { role: 'assistant', messageId });

export const toolStarted = (seq: number, id: string, toolName: string, args: unknown = {}) =>
  frame(seq, 'tool.execution.started', { toolCallId: id, toolName, args });

export const toolCompleted = (seq: number, id: string, result: unknown = 'ok', isError = false) =>
  frame(seq, 'tool.execution.completed', { toolCallId: id, result, isError });

/** Feed frames through a bridge the way the browser does. */
export function ingestAll(
  bridge: { ingestAgentEvent: (runId: string, ev: never) => void },
  runId: string,
  frames: WireFrame[],
): void {
  for (const f of frames) bridge.ingestAgentEvent(runId, f as never);
}
