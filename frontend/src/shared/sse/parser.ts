/**
 * Incremental SSE consumer — handles fragmented chunks, multi-byte UTF-8,
 * trailing buffer flush, malformed JSON, and abort.
 */

export type SSEEvent = Record<string, unknown> & { type?: string };

export interface SSEParserOptions {
  onEvent?: (ev: SSEEvent) => void;
  onMalformed?: (raw: string, err: Error) => void;
}

export interface SSEParser {
  feed: (chunk: string | Uint8Array | ArrayBuffer | null | undefined) => SSEEvent[];
  flush: () => SSEEvent[];
  abort: () => void;
  readonly aborted: boolean;
  readonly buffer: string;
}

/**
 * Create a pure incremental SSE parser (no I/O).
 * Feed chunks; call flush() when the stream ends; abort() to stop.
 */
export function createSSEParser(opts: SSEParserOptions = {}): SSEParser {
  const onEvent = opts.onEvent || null;
  const onMalformed = opts.onMalformed || null;
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let buf = '';
  let aborted = false;

  function parseLines(lines: string[]): SSEEvent[] {
    const events: SSEEvent[] = [];
    if (aborted) return events;

    for (const line of lines) {
      // Tolerate CRLF: strip trailing \r left by split('\n')
      const cleaned = line.endsWith('\r') ? line.slice(0, -1) : line;
      if (!cleaned.startsWith('data: ')) continue;
      const json = cleaned.slice(6).trim();
      if (!json) continue;
      try {
        const ev = JSON.parse(json) as SSEEvent;
        events.push(ev);
        if (onEvent) onEvent(ev);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (onMalformed) onMalformed(json, error);
        else console.warn('[sse] malformed event:', error.message, json.slice(0, 120));
      }
    }
    return events;
  }

  function feed(chunk: string | Uint8Array | ArrayBuffer | null | undefined): SSEEvent[] {
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

  function flush(): SSEEvent[] {
    if (aborted) return [];
    // Finalize any multi-byte sequence held by the decoder
    buf += decoder.decode();
    if (!buf) return [];
    // Remaining buffer may be a complete final line without trailing newline
    const lines = buf.split('\n');
    buf = '';
    return parseLines(lines);
  }

  function abort(): void {
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
 */
export async function readSSEStream(
  resp: Response,
  onEvent: (ev: SSEEvent) => void,
  signal?: AbortSignal | null,
): Promise<void> {
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
