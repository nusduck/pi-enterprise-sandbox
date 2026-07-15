import { mapSdkEventToSse } from '../services/sdk-sse-map.js';

/**
 * Bridge Pi session events to the platform event stream and durable event log.
 * Token persistence is batched while semantic boundaries are flushed eagerly.
 */
export function createEventBridge(options) {
  const pendingToolArgs = new Map();
  // A promise tail preserves DB sequence order. A Set would only wait for
  // completion and could let concurrent appends race for the next sequence.
  let persistTail = Promise.resolve();
  let firstPersistError = null;
  let tokenBatch = '';
  let tokenBatchTimer = null;

  const trackPersist = (type, payload, semantic = false) => {
    const task = persistTail.then(() =>
      options.persistEvent(type, payload, { required: semantic }),
    );
    const observed = task.catch((err) => {
      if (semantic && !firstPersistError) firstPersistError = err;
      // Continue the queue so later terminal reconciliation events can still
      // be attempted, while flush() exposes the first semantic failure.
      return null;
    });
    persistTail = observed;
    // Callers inside the synchronous SDK subscription intentionally do not
    // await this promise; attach an explicit handled observer to every such
    // task while flush() reports the saved semantic error.
    void task.catch(() => {});
    return task;
  };

  const drain = async (reportError = true) => {
    await persistTail;
    if (reportError && firstPersistError) {
      const error = firstPersistError;
      firstPersistError = null;
      throw error;
    }
  };

  const flush = async ({ reportError = true } = {}) => {
    if (!tokenBatch) {
      await drain(reportError);
      return;
    }
    const text = tokenBatch;
    tokenBatch = '';
    if (tokenBatchTimer) clearTimeout(tokenBatchTimer);
    tokenBatchTimer = null;
    trackPersist('token_batch', { text });
    await drain(reportError);
  };

  const scheduleToken = (text) => {
    tokenBatch += text;
    if (!tokenBatchTimer) {
      tokenBatchTimer = setTimeout(() => {
        void flush({ reportError: false }).catch(() => {});
      }, 250);
    }
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
        // Preserve ordering: token batches are queued before the semantic
        // boundary, and the caller can await flush()/dispose() before
        // terminalizing the run.
        void flush({ reportError: false }).catch(() => {});
        trackPersist(payload.type, payload, true);
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
    async dispose() {
      if (typeof unsubscribe === 'function') unsubscribe();
      if (tokenBatchTimer) clearTimeout(tokenBatchTimer);
      tokenBatchTimer = null;
      await flush();
    },
  };
}
