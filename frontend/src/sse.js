/**
 * Incremental SSE consumer — handles fragmented chunks, multi-byte UTF-8,
 * trailing buffer flush, malformed JSON, and abort.
 */

/**
 * Create a pure incremental SSE parser (no I/O).
 * Feed chunks; call flush() when the stream ends; abort() to stop.
 *
 * @param {{ onEvent?: (ev: object) => void, onMalformed?: (raw: string, err: Error) => void }} [opts]
 */
export function createSSEParser(opts = {}) {
  const onEvent = opts.onEvent || null;
  const onMalformed = opts.onMalformed || null;
  /** @type {TextDecoder} */
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let buf = '';
  let aborted = false;

  function parseLines(lines) {
    const events = [];
    if (aborted) return events;

    for (const line of lines) {
      // Tolerate CRLF: strip trailing \r left by split('\n')
      const cleaned = line.endsWith('\r') ? line.slice(0, -1) : line;
      if (!cleaned.startsWith('data: ')) continue;
      const json = cleaned.slice(6).trim();
      if (!json) continue;
      try {
        const ev = JSON.parse(json);
        events.push(ev);
        if (onEvent) onEvent(ev);
      } catch (err) {
        if (onMalformed) onMalformed(json, err);
        else console.warn('[sse] malformed event:', err?.message || err, json.slice(0, 120));
      }
    }
    return events;
  }

  /**
   * Feed a string or binary chunk. Returns events parsed from complete lines.
   * @param {string|Uint8Array|ArrayBuffer} chunk
   * @returns {object[]}
   */
  function feed(chunk) {
    if (aborted) return [];
    if (chunk == null) return [];

    if (typeof chunk === 'string') {
      buf += chunk;
    } else if (chunk instanceof ArrayBuffer) {
      buf += decoder.decode(new Uint8Array(chunk), { stream: true });
    } else if (ArrayBuffer.isView(chunk)) {
      buf += decoder.decode(chunk, { stream: true });
    } else {
      buf += String(chunk);
    }

    const lines = buf.split('\n');
    buf = lines.pop() || '';
    return parseLines(lines);
  }

  /**
   * Flush trailing buffer and TextDecoder state (call on stream end).
   * @returns {object[]}
   */
  function flush() {
    if (aborted) return [];
    // Finalize any multi-byte sequence held by the decoder
    buf += decoder.decode();
    if (!buf) return [];
    // Remaining buffer may be a complete final line without trailing newline
    const lines = buf.split('\n');
    buf = '';
    return parseLines(lines);
  }

  /** Stop parsing and clear partial state. */
  function abort() {
    aborted = true;
    buf = '';
  }

  return {
    feed,
    flush,
    abort,
    get aborted() {
      return aborted;
    },
    get buffer() {
      return buf;
    },
  };
}

/**
 * Read an SSE Response body, dispatching parsed events via onEvent.
 * Flushes trailing buffer on normal end; abort signal stops dispatch.
 *
 * @param {Response} resp
 * @param {(ev: object) => void} onEvent
 * @param {AbortSignal} [signal]
 */
export async function readSSEStream(resp, onEvent, signal) {
  if (!resp?.body?.getReader) {
    throw new Error('SSE response body is not readable');
  }

  const reader = resp.body.getReader();
  const parser = createSSEParser({ onEvent });

  const onAbort = () => {
    parser.abort();
    try {
      reader.cancel();
    } catch {
      /* ignore */
    }
  };

  if (signal) {
    if (signal.aborted) {
      parser.abort();
      try {
        reader.releaseLock?.();
      } catch {
        /* ignore */
      }
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    while (true) {
      if (signal?.aborted || parser.aborted) break;
      const { done, value } = await reader.read();
      if (done) {
        // Final flush so trailing partial line is not dropped
        parser.flush();
        break;
      }
      parser.feed(value);
    }
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    try {
      reader.releaseLock?.();
    } catch {
      /* ignore */
    }
  }
}
