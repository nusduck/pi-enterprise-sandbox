import { mapSdkEventToSse } from '../services/sdk-sse-map.js';

/**
 * Bridge Pi session events to the platform event stream and durable event log.
 * Token persistence is batched while semantic boundaries are flushed eagerly.
 */
export function createEventBridge(options) {
  const pendingToolArgs = new Map();
  let tokenBatch = '';
  let tokenBatchTimer = null;

  const flush = () => {
    if (!tokenBatch) return;
    const text = tokenBatch;
    tokenBatch = '';
    if (tokenBatchTimer) clearTimeout(tokenBatchTimer);
    tokenBatchTimer = null;
    void options.persistEvent('token_batch', { text });
  };

  const scheduleToken = (text) => {
    tokenBatch += text;
    if (!tokenBatchTimer) tokenBatchTimer = setTimeout(flush, 250);
  };

  const unsubscribe = options.session.subscribe((event) => {
    if (options.isCancelled()) return;
    for (const payload of mapSdkEventToSse(event, { pendingToolArgs })) {
      if (payload.type === 'token' && typeof payload.text === 'string') {
        options.onToken(payload.text);
        scheduleToken(payload.text);
      } else if (
        payload.type === 'tool_start' ||
        payload.type === 'tool_end' ||
        payload.type === 'approval_required' ||
        payload.type === 'error' ||
        payload.type === 'file_ready'
      ) {
        flush();
        void options.persistEvent(payload.type, payload);
        if (payload.type === 'tool_start') {
          void options.enforceBudgetOrAbort(
            options.budget.recordToolCall({
              isProcessStart: String(payload.name || '') === 'process_start',
            }),
          );
        } else if (payload.type === 'tool_end') {
          void options.enforceBudgetOrAbort(
            options.budget.recordToolResult({
              isError: Boolean(payload.isError),
              isProcessEnd: String(payload.name || '') === 'process_cancel',
            }),
          );
        }
        if (payload.type === 'tool_start' || payload.type === 'tool_end') {
          void options.flushSessionEntries();
        }
      }
      options.emit(payload);
    }
  });

  return {
    flush,
    dispose() {
      flush();
      if (typeof unsubscribe === 'function') unsubscribe();
    },
  };
}
