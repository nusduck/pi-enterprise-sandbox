/**
 * PR-09 BFF dataset/artifact proxy helpers — streaming spill + ownership headers.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { mapUploadErrorBody } from '../routes/files.js';
import {
  createBoundedDatasetUploadBody,
  datasetOwnershipHeaders,
  handleDatasetUpload,
  pipeWithBackpressure,
} from '../routes/datasets.js';
import { sandboxProxyHeaders } from '../routes/files.js';
import { config } from '../config.js';

class MockResponse extends EventEmitter {
  writableEnded = false;
  destroyed = false;
  status = null;
  headers = null;
  body = '';

  writeHead(status, headers) {
    this.status = status;
    this.headers = headers;
  }

  end(body = '') {
    this.body += String(body);
    this.writableEnded = true;
  }
}

function agentSessionResponse(conversationId = 'conversation_01') {
  return new Response(
    JSON.stringify({
      session_id: 'session_01',
      conversation_id: conversationId,
      org_id: '01ORG0000000000000000000000',
      user_id: '01USER000000000000000000000',
      workspace_id: '01WORK000000000000000000000',
      agent_session_id: '01AGENT00000000000000000000',
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

describe('datasetOwnershipHeaders', () => {
  it('prefers explicit conversation context', () => {
    const h = datasetOwnershipHeaders(
      { headers: { 'x-org-id': 'from-req' } },
      { conversationId: '01CONV', orgId: '01ORG', userId: '01USER' },
    );
    assert.equal(h['X-Conversation-Id'], '01CONV');
    assert.equal(h['X-Org-Id'], '01ORG');
    assert.equal(h['X-User-Id'], '01USER');
  });

  it('never stamps tenant principals from browser X-Org-Id / X-User-Id', () => {
    const h = datasetOwnershipHeaders({
      headers: {
        'x-conversation-id': 'c1',
        'x-org-id': 'o1',
        'x-user-id': 'u1',
      },
    });
    assert.equal(h['X-Conversation-Id'], 'c1');
    assert.equal(h['X-Org-Id'], undefined);
    assert.equal(h['X-User-Id'], undefined);
  });
});

describe('sandboxProxyHeaders trusted owner hop', () => {
  it('uses internal acting headers and suppresses the browser Bearer', () => {
    const headers = sandboxProxyHeaders(
      { headers: { authorization: 'Bearer external-jwt' } },
      { 'X-Acting-User-Id': 'forged' },
      {
        actingUserId: '01USER000000000000000000000',
        actingOrganizationId: '01ORG0000000000000000000000',
        actingRole: 'user',
      },
    );
    assert.equal(headers.Authorization, undefined);
    assert.equal(headers['X-Acting-User-Id'], '01USER000000000000000000000');
    assert.equal(
      headers['X-Acting-Organization-Id'],
      '01ORG0000000000000000000000',
    );
  });
});

describe('direct bounded Dataset upload body', () => {
  it('forwards a large multi-chunk body without a temp-file spill', async () => {
    const chunk = Buffer.alloc(64 * 1024, 7);
    const chunks = Array.from({ length: 16 }, () => chunk);
    const bounded = createBoundedDatasetUploadBody(
      Readable.from(chunks),
      2 * 1024 * 1024,
    );
    let size = 0;
    for await (const part of bounded.stream) {
      size += part.length;
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(size, 1024 * 1024);
    assert.equal(bounded.bytesRead, size);
    assert.equal(bounded.limitError, null);
  });

  it('fails as soon as streamed bytes exceed the configured bound', async () => {
    const bounded = createBoundedDatasetUploadBody(
      Readable.from([Buffer.from('1234'), Buffer.from('5678')]),
      7,
    );
    await assert.rejects(
      async () => {
        for await (const _chunk of bounded.stream) {
          // Consume through the Transform so its byte counter is authoritative.
        }
      },
      (error) => error?.status === 413 && error?.code === 'dataset_too_large',
    );
    assert.equal(bounded.limitError?.code, 'dataset_too_large');
  });
});

describe('handleDatasetUpload direct proxy', () => {
  it('rejects a missing Idempotency-Key before opening the upstream stream', async () => {
    const req = Object.assign(Readable.from([Buffer.from('should-not-forward')]), {
      headers: { 'content-type': 'application/octet-stream' },
      complete: true,
      aborted: false,
    });
    const res = new MockResponse();
    await handleDatasetUpload(
      'conversation_01',
      new URL('http://bff/upload?session_id=session_01'),
      req,
      res,
    );
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(res.body).code, 'dataset_idempotency_key_required');
  });

  it('streams to the conversation Dataset endpoint and forwards Idempotency-Key', async () => {
    const originalFetch = globalThis.fetch;
    const originalAuth = config.AUTH_ENABLED;
    let captured = null;
    globalThis.fetch = (async (url, init) => {
      if (String(url).includes('/internal/sessions/')) {
        return agentSessionResponse();
      }
      const parts = [];
      for await (const part of init.body) parts.push(Buffer.from(part));
      captured = { url: String(url), init, body: Buffer.concat(parts).toString() };
      return new Response(JSON.stringify({ dataset_id: 'dataset_01', status: 'ready' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json', 'X-Trace-Id': 'sandbox-trace' },
      });
    });
    config.AUTH_ENABLED = false;
    const req = Object.assign(Readable.from([Buffer.from('abc'), Buffer.from('def')]), {
      headers: {
        'content-type': 'multipart/form-data; boundary=test',
        'content-length': '6',
        'idempotency-key': 'idem-dataset-01',
        'x-trace-id': 'browser-trace',
      },
      complete: true,
      aborted: false,
    });
    const res = new MockResponse();
    try {
      await handleDatasetUpload(
        'conversation_01',
        new URL('http://bff/api/conversations/conversation_01/datasets?session_id=session_01'),
        req,
        res,
      );
      assert.equal(captured.body, 'abcdef');
      assert.equal(
        captured.url,
        `${config.SANDBOX_BASE_URL}/sessions/session_01/datasets`,
      );
      assert.equal(captured.init.headers['Idempotency-Key'], 'idem-dataset-01');
      assert.equal(captured.init.headers['X-Conversation-Id'], 'conversation_01');
      assert.equal(
        captured.init.headers['X-Acting-User-Id'],
        '01USER000000000000000000000',
      );
      assert.equal(captured.init.headers.Authorization, undefined);
      assert.equal(res.status, 201);
      assert.equal(JSON.parse(res.body).conversation_id, 'conversation_01');
    } finally {
      globalThis.fetch = originalFetch;
      config.AUTH_ENABLED = originalAuth;
    }
  });

  it('maps a streamed byte-limit failure to 413', async () => {
    const originalFetch = globalThis.fetch;
    const originalLimit = config.DATASET_UPLOAD_MAX_BYTES;
    const originalAuth = config.AUTH_ENABLED;
    globalThis.fetch = (async (url, init) => {
      if (String(url).includes('/internal/sessions/')) {
        return agentSessionResponse();
      }
      for await (const _part of init.body) {
        // Deliberately consume the upstream body to exercise the Transform.
      }
      return new Response('{}', { status: 201 });
    });
    config.AUTH_ENABLED = false;
    config.DATASET_UPLOAD_MAX_BYTES = 5;
    const req = Object.assign(
      Readable.from([Buffer.from('123'), Buffer.from('456')]),
      {
        headers: {
          'content-type': 'multipart/form-data; boundary=test',
          'idempotency-key': 'idem-limit-01',
        },
        complete: true,
        aborted: false,
      },
    );
    const res = new MockResponse();
    try {
      await handleDatasetUpload(
        'conversation_01',
        new URL('http://bff/upload?session_id=session_01'),
        req,
        res,
      );
      assert.equal(res.status, 413);
      assert.equal(JSON.parse(res.body).code, 'dataset_too_large');
    } finally {
      globalThis.fetch = originalFetch;
      config.DATASET_UPLOAD_MAX_BYTES = originalLimit;
      config.AUTH_ENABLED = originalAuth;
    }
  });

  it('aborts the Sandbox fetch when the browser disconnects', async () => {
    const originalFetch = globalThis.fetch;
    const originalAuth = config.AUTH_ENABLED;
    let sandboxAborted = false;
    globalThis.fetch = ((url, init) => {
      if (String(url).includes('/internal/sessions/')) {
        return Promise.resolve(agentSessionResponse());
      }
      return new Promise((_resolve, reject) => {
        const onAbort = () => {
          sandboxAborted = true;
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        };
        if (init.signal.aborted) onAbort();
        else init.signal.addEventListener('abort', onAbort, { once: true });
      });
    });
    config.AUTH_ENABLED = false;
    const req = Object.assign(new PassThrough(), {
      headers: {
        'content-type': 'multipart/form-data; boundary=test',
        'idempotency-key': 'idem-abort-01',
      },
      complete: false,
      aborted: false,
    });
    const res = new MockResponse();
    const pending = handleDatasetUpload(
      'conversation_01',
      new URL('http://bff/upload?session_id=session_01'),
      req,
      res,
    );
    await new Promise((resolve) => setImmediate(resolve));
    req.aborted = true;
    req.emit('aborted');
    try {
      await pending;
      assert.equal(sandboxAborted, true);
      assert.equal(res.writableEnded, false);
    } finally {
      req.destroy();
      globalThis.fetch = originalFetch;
      config.AUTH_ENABLED = originalAuth;
    }
  });
});

describe('mapUploadErrorBody dataset codes', () => {
  it('preserves workspace_quota_exceeded', () => {
    const out = mapUploadErrorBody(413, {
      detail: { code: 'workspace_quota_exceeded', message: 'quota' },
    }, 't');
    assert.equal(out.code, 'workspace_quota_exceeded');
  });
});

describe('pipeWithBackpressure', () => {
  it('writes all chunks and ends', async () => {
    const chunks = [Buffer.from('a'), Buffer.from('b'), Buffer.from('c')];
    const written = [];
    const res = {
      writableEnded: false,
      destroyed: false,
      write(c) {
        written.push(Buffer.from(c).toString());
        return true;
      },
      end() {
        this.writableEnded = true;
      },
      once() {},
    };
    const req = { on() {}, off() {} };
    await pipeWithBackpressure(req, res, (async function* () {
      for (const c of chunks) yield c;
    })());
    assert.deepEqual(written, ['a', 'b', 'c']);
    assert.equal(res.writableEnded, true);
  });

  it('stops when client aborts (close)', async () => {
    let closeHandler = null;
    const req = {
      on(ev, fn) {
        if (ev === 'close') closeHandler = fn;
      },
      off() {},
    };
    const written = [];
    const res = {
      writableEnded: false,
      destroyed: false,
      write(c) {
        written.push(Buffer.from(c).toString());
        if (written.length === 1 && closeHandler) closeHandler();
        return true;
      },
      end() {
        this.writableEnded = true;
      },
      once() {},
    };
    await pipeWithBackpressure(req, res, (async function* () {
      yield Buffer.from('1');
      yield Buffer.from('2');
      yield Buffer.from('3');
    })());
    assert.equal(written.length, 1);
    assert.equal(res.writableEnded, true);
  });
});
