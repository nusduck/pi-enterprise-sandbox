import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { uploadDataset } from '../src/shared/api/datasets.ts';
import { createEntityBridge } from '../src/features/chat/entityBridge.ts';
import {
  canSendAttachments,
  createAttachmentDraft,
  patchAttachment,
} from '../src/shared/state/index.ts';

function readyDataset(overrides: Record<string, unknown> = {}) {
  return {
    dataset_id: 'dataset_01',
    org_id: 'org_01',
    user_id: 'user_01',
    conversation_id: 'conversation_01',
    agent_session_id: 'agent_session_01',
    sandbox_session_id: 'sandbox_session_01',
    original_filename: 'sales.csv',
    name: 'sales.csv',
    path: 'datasets/dataset_01/sales.csv',
    stored_relative_path: 'datasets/dataset_01/sales.csv',
    mime_type: 'text/csv',
    size_bytes: 7,
    size: 7,
    sha256: 'a'.repeat(64),
    status: 'ready',
    created_at: '2026-07-18T01:00:00Z',
    completed_at: '2026-07-18T01:00:01Z',
    ...overrides,
  };
}

function namedBlob(name: string): Blob {
  const blob = new Blob(['a,b\n1,2'], { type: 'text/csv' });
  Object.defineProperty(blob, 'name', { value: name });
  return blob;
}

describe('Dataset upload API', () => {
  it('uses the conversation route and forwards trace/idempotency headers', async () => {
    const originalFetch = globalThis.fetch;
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = (async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(JSON.stringify(readyDataset()), {
        status: 201,
        headers: {
          'Content-Type': 'application/json',
          'X-Trace-Id': 'trace_from_response',
        },
      });
    }) as typeof fetch;

    try {
      const result = await uploadDataset({
        conversationId: 'conversation_01',
        sessionId: 'sandbox_session_01',
        file: namedBlob('sales.csv'),
        idempotencyKey: 'idem_draft_01',
        traceId: 'trace_request',
      });
      assert.equal(
        capturedUrl,
        '/api/conversations/conversation_01/datasets?session_id=sandbox_session_01',
      );
      const headers = capturedInit?.headers as Record<string, string>;
      assert.equal(headers['Idempotency-Key'], 'idem_draft_01');
      assert.equal(headers['X-Trace-Id'], 'trace_request');
      assert.ok(capturedInit?.body instanceof FormData);
      assert.equal((capturedInit.body as FormData).get('file') instanceof Blob, true);
      assert.equal(result.dataset_id, 'dataset_01');
      assert.equal(result.trace_id, 'trace_from_response');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects a non-READY success body', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(readyDataset({ status: 'uploading' })), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
    try {
      await assert.rejects(
        uploadDataset({
          conversationId: 'conversation_01',
          sessionId: 'sandbox_session_01',
          file: namedBlob('sales.csv'),
          idempotencyKey: 'idem-non-ready',
        }),
        /dataset upload contract mismatch/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('performs one request attempt when the caller supplies a durable key', async () => {
    const originalFetch = globalThis.fetch;
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      return new Response(
        JSON.stringify({ error: 'temporarily unavailable', code: 'unavailable' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;
    try {
      await assert.rejects(
        uploadDataset({
          conversationId: 'conversation_01',
          sessionId: 'sandbox_session_01',
          file: namedBlob('sales.csv'),
          idempotencyKey: 'idem_draft_01',
        }),
        /temporarily unavailable/,
      );
      assert.equal(attempts, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects an empty idempotency key before making a request', async () => {
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('{}', { status: 500 });
    }) as typeof fetch;
    try {
      await assert.rejects(
        uploadDataset({
          conversationId: 'conversation_01',
          sessionId: 'sandbox_session_01',
          file: namedBlob('sales.csv'),
          idempotencyKey: '',
        }),
        /idempotencyKey is required/,
      );
      assert.equal(called, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('immediately upserts the Dataset while preserving composer sendability', () => {
    const bridge = createEntityBridge();
    const row = readyDataset();
    const entity = bridge.recordDataset(row, {
      conversationId: 'conversation_01',
      sessionId: 'sandbox_session_01',
    });
    assert.equal(entity?.status, 'ready');
    assert.equal(bridge.getStore().datasetsById.dataset_01.path, row.path);

    const draft = createAttachmentDraft(namedBlob('sales.csv'));
    const attachments = patchAttachment([draft], draft.localId, {
      status: 'uploaded',
      attachmentId: row.dataset_id,
      path: row.path,
      size: row.size,
      progress: 100,
    });
    assert.equal(canSendAttachments(attachments), true);
    assert.equal(attachments[0].attachmentId, 'dataset_01');
  });
});
