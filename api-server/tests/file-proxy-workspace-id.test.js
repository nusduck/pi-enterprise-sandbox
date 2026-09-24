/**
 * `/api/files/*` 代理的 ID 域回归：浏览器给的是 sandbox_session_id，
 * exec 公共面 `/sessions/:id/files/*` 的 `:id` 却是 workspace_id
 * （exec `requireOwnedSession()` 拿它派生物理工作区路径）。
 *
 * 修复前 download/upload 直接把 session id 塞进 URL：下载恒 404，
 * 上传静默写进一个没人读的幽灵工作区。这两条用例在修复前会失败。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { handleFileDownload, handleFileUpload } from '../src/routes/files.js';
import { config } from '../src/config.js';

const SESSION_ID = '01SESSION0000000000000000000';
const WORKSPACE_ID = '01WORKSPACE00000000000000000';

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

  write(chunk) {
    this.body += Buffer.isBuffer(chunk) || ArrayBuffer.isView(chunk)
      ? Buffer.from(chunk).toString('utf8')
      : String(chunk);
    return true;
  }

  end(body = '') {
    this.body += String(body);
    this.writableEnded = true;
    this.emit('finish');
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function agentSessionResponse() {
  return jsonResponse({
    conversation_id: '01CONVERSATION000000000000',
    session_id: SESSION_ID,
    sandbox_session_id: SESSION_ID,
    workspace_id: WORKSPACE_ID,
    org_id: '01ORG0000000000000000000000',
    user_id: '01USER000000000000000000000',
  });
}

/** 最小 IncomingMessage 替身：上传路径要真的能被流式读干净。 */
function uploadRequest(payload = 'hello') {
  const req = new EventEmitter();
  req.headers = { 'content-type': 'application/octet-stream' };
  req.complete = false;
  req.resume = () => {};
  req.pause = () => {};
  req.destroy = () => {};
  req.traceId = null;
  req.traceContext = null;
  setImmediate(() => {
    req.emit('data', Buffer.from(payload));
    req.complete = true;
    req.emit('end');
  });
  return req;
}

async function withStubbedFetch(handler, run) {
  const originalFetch = globalThis.fetch;
  const originalAuth = config.AUTH_ENABLED;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const value = String(url);
    calls.push({ url: value, init });
    if (value.includes('/internal/sessions/')) return agentSessionResponse();
    const answer = handler(value, init);
    if (answer) return answer;
    throw new Error(`Unexpected fetch: ${value}`);
  };
  config.AUTH_ENABLED = false;
  try {
    await run(calls);
  } finally {
    globalThis.fetch = originalFetch;
    config.AUTH_ENABLED = originalAuth;
  }
}

describe('file proxy id domain', () => {
  it('downloads through the workspace_id, not the sandbox session id', async () => {
    await withStubbedFetch(
      (url) =>
        url.includes(`/sessions/${WORKSPACE_ID}/files/download`)
          ? new Response('file-bytes', {
              status: 200,
              headers: { 'Content-Type': 'text/plain' },
            })
          : null,
      async (calls) => {
        const res = new MockResponse();
        await handleFileDownload(
          new URL(
            `http://bff/api/files/download?session_id=${SESSION_ID}&path=out.txt`,
          ),
          res,
          { headers: {} },
        );
        assert.equal(res.status, 200);
        assert.equal(res.body, 'file-bytes');
        const sandboxCall = calls.find((call) => call.url.includes('/files/download'));
        assert.ok(sandboxCall, 'sandbox download was never called');
        assert.ok(
          sandboxCall.url.includes(`/sessions/${WORKSPACE_ID}/files/download`),
          `expected workspace-keyed URL, got ${sandboxCall.url}`,
        );
        assert.ok(!sandboxCall.url.includes(SESSION_ID));
      },
    );
  });

  it('uploads through the workspace_id, not the sandbox session id', async () => {
    await withStubbedFetch(
      (url) =>
        url.includes(`/sessions/${WORKSPACE_ID}/files/upload`)
          ? jsonResponse(
              { attachment_id: 'att_1', path: 'uploads/a.txt', size: 5 },
              201,
            )
          : null,
      async (calls) => {
        const res = new MockResponse();
        await handleFileUpload(
          new URL(`http://bff/api/files/upload?session_id=${SESSION_ID}`),
          uploadRequest(),
          res,
        );
        assert.equal(res.status, 201);
        const sandboxCall = calls.find((call) => call.url.includes('/files/upload'));
        assert.ok(sandboxCall, 'sandbox upload was never called');
        assert.ok(
          sandboxCall.url.includes(`/sessions/${WORKSPACE_ID}/files/upload`),
          `expected workspace-keyed URL, got ${sandboxCall.url}`,
        );
        assert.ok(!sandboxCall.url.includes(SESSION_ID));
      },
    );
  });

  it('fails closed with 503 when Agent returns no workspace_id', async () => {
    const originalFetch = globalThis.fetch;
    const originalAuth = config.AUTH_ENABLED;
    globalThis.fetch = async (url) => {
      const value = String(url);
      if (value.includes('/internal/sessions/')) {
        return jsonResponse({
          conversation_id: '01CONVERSATION000000000000',
          session_id: SESSION_ID,
          org_id: '01ORG0000000000000000000000',
          user_id: '01USER000000000000000000000',
        });
      }
      throw new Error(`Unexpected fetch: ${value}`);
    };
    config.AUTH_ENABLED = false;
    try {
      const res = new MockResponse();
      await handleFileDownload(
        new URL(
          `http://bff/api/files/download?session_id=${SESSION_ID}&path=out.txt`,
        ),
        res,
        { headers: {} },
      );
      assert.equal(res.status, 503);
      assert.equal(JSON.parse(res.body).code, 'SESSION_WORKSPACE_UNAVAILABLE');
    } finally {
      globalThis.fetch = originalFetch;
      config.AUTH_ENABLED = originalAuth;
    }
  });
});
