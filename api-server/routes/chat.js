/**
 * Route: POST /api/chat — thin BFF SSE relay to the Agent service.
 *
 * Browser contract unchanged: POST /api/chat with messages → SSE event stream.
 * BFF creates an agent run, streams sequenced events, and cancels on disconnect.
 * Does NOT import or run pi-coding-agent.
 */
import { randomUUID } from 'node:crypto';
import { authFromRequest } from '../services/sandbox-client.js';
import {
  createAgentRun,
  openAgentRunEvents,
  cancelAgentRun,
} from '../services/agent-client.js';

/**
 * @param {object} body
 * @param {import('node:http').ServerResponse} res
 * @param {import('node:http').IncomingMessage} [req]
 */
export async function handleChat(body, res, req = null) {
  const messages = body?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'messages array is required' }));
    return;
  }

  const trace_id = randomUUID();
  const auth = authFromRequest(req);
  const ac = new AbortController();
  let finished = false;
  let runId = null;

  const onClientGone = () => {
    if (finished) return;
    try {
      ac.abort();
    } catch {
      /* ignore */
    }
    if (runId) {
      cancelAgentRun(runId).catch((err) => {
        console.warn('[bff-chat] cancel on disconnect failed:', err.message);
      });
    }
  };
  if (req) {
    req.on('close', onClientGone);
    req.on('aborted', onClientGone);
  }
  res.on('close', onClientGone);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Trace-Id': trace_id,
  });

  const sse = (data) => {
    if (res.writableEnded || res.destroyed) return;
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {
      /* stream may be closed */
    }
  };

  // Early trace so UI can correlate even before agent responds
  sse({ type: 'trace', trace_id });

  try {
    const created = await createAgentRun(
      {
        messages,
        conversation_id: body.conversation_id || null,
        trace_id,
      },
      { auth, traceId: trace_id },
    );
    runId = created.run_id;

    const upstream = await openAgentRunEvents(runId, 0, { signal: ac.signal });
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (res.writableEnded || res.destroyed) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        ac.abort();
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      // Parse SSE frames from agent (id + data envelopes)
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        const trimmed = line.replace(/\r$/, '');
        if (!trimmed || trimmed.startsWith(':') || trimmed.startsWith('event:')) {
          continue;
        }
        if (trimmed.startsWith('data:')) {
          const raw = trimmed.slice(5).trim();
          if (!raw) continue;
          try {
            const envelope = JSON.parse(raw);
            // Agent streams { sequence, event, ts } or terminal { status }
            if (envelope && envelope.event && typeof envelope.event === 'object') {
              // Skip duplicate early trace if agent also emits one
              if (envelope.event.type === 'trace' && envelope.event.trace_id === trace_id) {
                // Still forward — UI is fine with multiple traces; keep for parity
              }
              sse(envelope.event);
            } else if (envelope && envelope.status && !envelope.event) {
              // end event payload — no client payload needed
            } else if (envelope && envelope.type) {
              // Defensive: bare event shape
              sse(envelope);
            }
          } catch {
            // Non-JSON data lines — ignore
          }
        }
      }
    }
  } catch (err) {
    if (err?.name === 'AbortError') {
      return;
    }
    console.error('[bff-chat] Error:', err);
    sse({ type: 'error', message: err.message || String(err) });
    sse({ type: 'done' });
  } finally {
    finished = true;
    if (!res.writableEnded) res.end();
  }
}
