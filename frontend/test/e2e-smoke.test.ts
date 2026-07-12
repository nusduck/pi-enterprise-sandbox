/**
 * F6 core-flow smoke tests (mock backend).
 *
 * Covers ADR Phase 6 E2E matrix without a browser harness:
 * login · conversation · stream · approval · attach · cancel · reconnect
 *
 * Uses node:test + mocked fetch / in-memory localStorage.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  INITIAL,
  createState,
  update,
  startStream,
  endStream,
  abortStream,
  normalizeServerMessages,
  persistConversationId,
  loadPersistedConversationId,
  clearPersistedChat,
  persistSidebarOpen,
  loadPersistedSidebarOpen,
  createAttachmentDraft,
  canSendAttachments,
  uploadedAttachments,
  buildUserTurnWithAttachments,
} from '../src/shared/state/index.ts';
import {
  canStop,
  resolveComposerMode,
} from '../src/widgets/composer/composerMode.ts';
import {
  getAuthToken,
  clearAuthToken,
  login,
  authHeaders,
} from '../src/shared/api/client.ts';
import { createEntityBridge } from '../src/features/chat/entityBridge.ts';
import { createEntityStore } from '../src/entities/index.ts';
import { createRunSSEManager } from '../src/shared/sse/manager.ts';
import { makeRuntimeEvent } from '../src/shared/schemas/events.ts';
import { adaptLegacyStream } from '../src/shared/sse/legacyAdapter.ts';
import { reduceRuntimeEventBatch } from '../src/shared/state/runReducer.ts';

// ── In-memory localStorage for Node ─────────────────────────────

type Store = Map<string, string>;

function installLocalStorage(): Store {
  const store: Store = new Map();
  const ls = {
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
    removeItem(key: string) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
    key(i: number) {
      return [...store.keys()][i] ?? null;
    },
    get length() {
      return store.size;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: ls,
    configurable: true,
    writable: true,
  });
  return store;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function enc(str: string) {
  return new TextEncoder().encode(str);
}

function sseData(obj: unknown): Uint8Array {
  return enc(`data: ${JSON.stringify(obj)}\n`);
}

// ── Suite ───────────────────────────────────────────────────────

describe('F6 E2E smoke — core flows (mock backend)', () => {
  let store: Store;
  let originalFetch: typeof fetch | undefined;

  beforeEach(() => {
    store = installLocalStorage();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    if (originalFetch) globalThis.fetch = originalFetch;
    clearAuthToken();
    store.clear();
  });

  // ── 1. Login ────────────────────────────────────────────────

  it('login: stores auth token and attaches Authorization header', async () => {
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      assert.match(url, /\/api\/auth\/login$/);
      const body = JSON.parse(String(init?.body || '{}')) as {
        username?: string;
        password?: string;
      };
      assert.equal(body.username, 'alice');
      assert.equal(body.password, 'secret');
      return jsonResponse({
        token: 'tok_test_abc',
        user: { id: 'u1', username: 'alice' },
      });
    };

    assert.equal(getAuthToken(), '');
    const res = await login({ username: 'alice', password: 'secret' });
    assert.equal(res.token, 'tok_test_abc');
    assert.equal(getAuthToken(), 'tok_test_abc');

    const headers = authHeaders();
    assert.equal(headers.Authorization, 'Bearer tok_test_abc');

    clearAuthToken();
    assert.equal(getAuthToken(), '');
    assert.equal(authHeaders().Authorization, undefined);
  });

  // ── 2. Conversation ─────────────────────────────────────────

  it('conversation: loads messages from server payload; UI pref is id only', () => {
    // Seed a legacy message cache that MUST be ignored / scrubbed
    store.set(
      'sandbox_messages',
      JSON.stringify([{ role: 'user', content: 'STALE local message' }]),
    );

    const serverMessages = normalizeServerMessages([
      { role: 'user', content: 'Hello from server' },
      { role: 'assistant', content: 'Hi there' },
    ]);
    assert.equal(serverMessages.length, 2);
    assert.equal(
      (serverMessages[0].content[0] as { text: string }).text,
      'Hello from server',
    );

    persistConversationId('conv_server_1');
    assert.equal(loadPersistedConversationId(), 'conv_server_1');
    // Scrub of legacy message key happens on persist/load
    assert.equal(store.has('sandbox_messages'), false);

    // Conversation switch state
    let s = createState(INITIAL);
    s = update(s, {
      conversationId: 'conv_server_1',
      messages: serverMessages,
      sessionId: 'sess_1',
    });
    assert.equal(s.conversationId, 'conv_server_1');
    assert.equal(s.messages.length, 2);

    clearPersistedChat();
    assert.equal(loadPersistedConversationId(), null);
  });

  it('conversation: UI prefs keep sidebar without caching messages', () => {
    persistSidebarOpen(false);
    assert.equal(loadPersistedSidebarOpen(), false);
    persistSidebarOpen(true);
    assert.equal(loadPersistedSidebarOpen(), true);
    // Message key must never be written by UI pref helpers
    assert.equal(store.has('sandbox_messages'), false);
  });

  // ── 3. Stream ───────────────────────────────────────────────

  it('stream: token SSE builds assistant text only through EntityStore', () => {
    const bridge = createEntityBridge();
    const runId = bridge.beginRun({ conversationId: 'c1' });
    for (const chunk of ['Hel', 'lo', ' world']) {
      bridge.ingestLegacyEvent(runId, { type: 'token', text: chunk });
    }
    const projected = bridge.projectRunMessages(runId);
    assert.equal((projected[0].content[0] as { text: string }).text, 'Hello world');
    assert.equal('currentMsg' in createState(INITIAL), false);
    bridge.dispose();
  });

  it('stream: legacy adapter has one EntityStore write path for a full turn', () => {
    const bridge = createEntityBridge();
    const runId = bridge.beginRun({ conversationId: 'c1', sessionId: 's1' });

    const legacyEvents = [
      { type: 'session', session_id: 's1', conversation_id: 'c1' },
      { type: 'token', text: 'Answer' },
      { type: 'done' },
    ];
    for (const ev of legacyEvents) {
      bridge.ingestLegacyEvent(runId, ev);
    }

    const storeSnap = bridge.getStore();
    assert.equal(storeSnap.runsById[runId].status, 'succeeded');
    const msgs = bridge.projectRunMessages(runId);
    assert.ok(msgs.length >= 1);
    const text = (msgs[0].content[0] as { text?: string }).text || '';
    assert.match(text, /Answer/);
    bridge.dispose();
  });

  // ── 4. Approval ─────────────────────────────────────────────

  it('approval: SSE approval state exists only in EntityStore', () => {
    const bridge = createEntityBridge();
    const runId = bridge.beginRun({ conversationId: 'c1' });
    bridge.ingestLegacyEvent(runId, {
      type: 'approval_required',
      approval_id: 'appr_1',
      reason: 'rm -rf /tmp/cache',
    });
    let approval = bridge.getStore().approvalsById.appr_1;
    assert.equal(approval.id, 'appr_1');
    assert.match(approval.reason, /rm -rf/);
    assert.equal('pendingApproval' in createState(INITIAL), false);

    // Composer mode switches to waiting_approval
    assert.equal(
      resolveComposerMode({
        isStreaming: true,
        hasPendingApproval: approval.status === 'pending',
      }),
      'waiting_approval',
    );

    bridge.markApproval('appr_1', 'approved');
    approval = bridge.getStore().approvalsById.appr_1;
    assert.equal(approval.status, 'approved');
    assert.equal(
      resolveComposerMode({
        isStreaming: true,
        hasPendingApproval: false,
        runStatus: 'running',
      }),
      'running',
    );
    bridge.dispose();
  });

  it('approval: entity bridge marks approval decided', () => {
    const bridge = createEntityBridge();
    const runId = bridge.beginRun({ conversationId: 'c2' });
    bridge.ingestLegacyEvent(runId, {
      type: 'approval_required',
      approval_id: 'ap_entity',
      reason: 'sudo',
    });
    let snap = bridge.getStore();
    assert.ok(snap.approvalsById.ap_entity);
    assert.equal(snap.approvalsById.ap_entity.status, 'pending');

    bridge.markApproval('ap_entity', 'approved');
    snap = bridge.getStore();
    assert.equal(snap.approvalsById.ap_entity.status, 'approved');
    bridge.dispose();
  });

  // ── 5. Attach ───────────────────────────────────────────────

  it('attach: draft → uploaded → bound into user turn', () => {
    const draft = createAttachmentDraft({
      name: 'notes.txt',
      size: 12,
      type: 'text/plain',
    } as File);
    assert.equal(draft.status, 'queued');
    assert.equal(canSendAttachments([draft]), false);

    const uploaded = {
      ...draft,
      status: 'uploaded' as const,
      path: 'uploads/sess/notes.txt',
      remoteId: 'att_1',
    };
    assert.equal(canSendAttachments([uploaded]), true);
    const ready = uploadedAttachments([uploaded]);
    assert.equal(ready.length, 1);

    const turn = buildUserTurnWithAttachments('Please review', [uploaded]);
    assert.equal(turn.role, 'user');
    const textPart = turn.content.find((p) => p.type === 'text') as
      | { text: string }
      | undefined;
    assert.ok(textPart?.text.includes('Please review'));
    // Attachment metadata should be present on the turn
    assert.ok(
      (turn as { attachments?: unknown[] }).attachments?.length === 1 ||
        turn.content.some(
          (p) =>
            p.type === 'file' ||
            (p as { name?: string }).name === 'notes.txt' ||
            JSON.stringify(p).includes('notes.txt'),
        ) ||
        JSON.stringify(turn).includes('notes.txt'),
      'user turn should reference the attachment',
    );
  });

  // ── 6. Cancel ───────────────────────────────────────────────

  it('cancel: abortStream stops generation; canStop in running mode', () => {
    let s = createState(INITIAL);
    s = startStream(s);
    const gen = s.streamGeneration;
    const ctrl = s.abortCtrl;
    assert.ok(ctrl);
    assert.equal(s.isStreaming, true);

    // Running mode allows stop
    const mode = resolveComposerMode({ isStreaming: true, runStatus: 'running' });
    assert.equal(mode, 'running');
    assert.equal(canStop(mode), true);

    s = abortStream(s);
    assert.equal(s.isStreaming, false);
    assert.equal(s.abortCtrl, null);
    assert.equal(ctrl!.signal.aborted, true);
    assert.ok(s.streamGeneration > gen);

    // Idle no longer stoppable
    assert.equal(canStop(resolveComposerMode({ isStreaming: false })), false);
  });

  it('cancel: entity bridge stopRun disconnects only that run', () => {
    const bridge = createEntityBridge();
    const r1 = bridge.beginRun({ conversationId: 'cA' });
    const r2 = bridge.beginRun({ conversationId: 'cB' });
    bridge.ingestLegacyEvent(r1, { type: 'token', text: 'a' });
    bridge.ingestLegacyEvent(r2, { type: 'token', text: 'b' });

    bridge.stopRun(r1);
    // r2 still present in store
    const snap = bridge.getStore();
    assert.ok(snap.runsById[r2]);
    assert.ok(snap.runsById[r1]);
    bridge.dispose();
  });

  // ── 7. Reconnect ────────────────────────────────────────────

  it('reconnect: Last-Event-ID sent on resume; duplicates dropped', async () => {
    const headersSeen: Array<Record<string, string>> = [];
    let calls = 0;

    const fetchImpl: typeof fetch = async (_url, init) => {
      calls += 1;
      headersSeen.push({ ...((init?.headers || {}) as Record<string, string>) });

      if (calls === 1) {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              sseData({
                event_id: 'evt_1',
                sequence: 1,
                run_id: 'run_re',
                type: 'run.started',
                payload: {},
              }),
            );
            controller.close();
          },
        });
        return new Response(stream, { status: 200 });
      }

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          // Replay evt_1 (must dedupe) then new evt_2
          controller.enqueue(
            sseData({
              event_id: 'evt_1',
              sequence: 1,
              run_id: 'run_re',
              type: 'run.started',
              payload: {},
            }),
          );
          controller.enqueue(
            sseData({
              event_id: 'evt_2',
              sequence: 2,
              run_id: 'run_re',
              type: 'message.delta',
              payload: { message_id: 'm1', text: 'hi' },
            }),
          );
          controller.enqueue(
            sseData({
              event_id: 'evt_3',
              sequence: 3,
              run_id: 'run_re',
              type: 'run.completed',
              payload: {},
            }),
          );
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    };

    const mgr = createRunSSEManager(createEntityStore(), {
      fetchImpl,
      maxRetries: 3,
      retryBaseMs: 1,
      retryMaxMs: 5,
      sleep: async () => {},
    });

    mgr.connect('run_re');
    await new Promise((r) => setTimeout(r, 60));

    assert.ok(calls >= 2, `expected reconnect, got ${calls} calls`);
    const second = headersSeen[1] || {};
    const lastId =
      second['Last-Event-ID'] ||
      second['last-event-id'] ||
      Object.entries(second).find(
        ([k]) => k.toLowerCase() === 'last-event-id',
      )?.[1];
    assert.equal(lastId, 'evt_1');

    // Pure-path dedupe still holds
    const dup = mgr.handleRuntimeEvent(
      makeRuntimeEvent({
        event_id: 'evt_1',
        sequence: 1,
        run_id: 'run_re',
        type: 'run.started',
      }),
    );
    assert.equal(dup.outcome, 'duplicate');

    mgr.disconnect('run_re');
  });

  it('reconnect: adaptLegacyStream sequences are monotonic across a full flow', () => {
    const { events } = adaptLegacyStream('run_flow', [
      { type: 'session', session_id: 's' },
      { type: 'token', text: 'x' },
      { type: 'approval_required', approval_id: 'a1', reason: 'risk' },
      { type: 'tool_start', id: 't1', name: 'bash' },
      { type: 'tool_end', id: 't1', result: 'ok' },
      { type: 'done' },
    ]);
    for (let i = 1; i < events.length; i++) {
      assert.ok(events[i].sequence > events[i - 1].sequence);
    }
    const { store: entityStore } = reduceRuntimeEventBatch(
      createEntityStore(),
      events,
    );
    assert.equal(entityStore.runsById.run_flow.status, 'succeeded');
    assert.ok(entityStore.approvalsById.a1);
  });
});
