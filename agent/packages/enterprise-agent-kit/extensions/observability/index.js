export function createObservabilityExtension(options = {}) {
  const emit = (type, payload = {}) => {
    options.emit?.({ type, ...payload, ...(options.getMeta?.() || {}) });
  };

  return function observabilityExtension(pi) {
    pi.on('session_start', (event) => emit('extension_session_start', { reason: event.reason }));
    pi.on('session_shutdown', (event) =>
      emit('extension_session_shutdown', { reason: event.reason }),
    );
    pi.on('session_before_compact', (event) => {
      emit('compaction_started', { reason: event.reason, will_retry: event.willRetry });
    });
    pi.on('session_compact', (event) => {
      emit('compaction_completed', { reason: event.reason, will_retry: event.willRetry });
    });
    pi.on('before_provider_request', () => emit('provider_request_started'));
    pi.on('after_provider_response', () => emit('provider_response_completed'));
  };
}
