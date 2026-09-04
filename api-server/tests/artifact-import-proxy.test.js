import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { handleImportArtifact, handleListArtifacts } from '../src/routes/artifacts.js';
import { config } from '../src/config.js';

class MockResponse extends EventEmitter {
  writableEnded = false;
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

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('artifact cross-conversation import proxy', () => {
  it('resolves the target owner through Agent and imports through Sandbox', async () => {
    const originalFetch = globalThis.fetch;
    const originalAuth = config.AUTH_ENABLED;
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
      const value = String(url);
      calls.push({ url: value, init });
      if (value.endsWith('/internal/sessions/ensure')) {
        return jsonResponse({
          conversation_id: 'conversation_target',
          session_id: 'session_target',
          workspace_id: 'workspace_target',
        });
      }
      if (value.endsWith('/internal/sessions/session_target')) {
        return jsonResponse({
          conversation_id: 'conversation_target',
          session_id: 'session_target',
          workspace_id: 'workspace_target',
          org_id: '01ORG0000000000000000000000',
          user_id: '01USER000000000000000000000',
        });
      }
      if (value.endsWith('/sessions/workspace_target/artifacts/imports')) {
        return jsonResponse(
          {
            import_id: '01IMPORT0000000000000000000',
            artifact_id: '01ARTIFACT00000000000000000',
            target_session_id: 'workspace_target',
            target_conversation_id: 'conversation_target',
            workspace_file: {
              name: 'report.pdf',
              path: 'imports/01IMPORT0000000000000000000/report.pdf',
              mime_type: 'application/pdf',
              size: 42,
              sha256: 'a'.repeat(64),
            },
          },
          201,
        );
      }
      throw new Error(`Unexpected fetch: ${value}`);
    };
    config.AUTH_ENABLED = false;
    const res = new MockResponse();
    const req = {
      headers: {},
      traceId: '0123456789abcdef0123456789abcdef',
      requestId: 'request-artifact-import',
      traceContext: null,
    };

    try {
      await handleImportArtifact(
        'conversation_target',
        {
          artifact_id: '01ARTIFACT00000000000000000',
          target_filename: 'report.pdf',
        },
        res,
        req,
      );
      assert.equal(res.status, 201);
      const body = JSON.parse(res.body);
      assert.equal(body.target_session_id, 'session_target');
      assert.equal(body.workspace_file.path.endsWith('/report.pdf'), true);

      const sandboxCall = calls.find((call) =>
        call.url.endsWith('/sessions/workspace_target/artifacts/imports'),
      );
      assert.ok(sandboxCall);
      assert.equal(
        sandboxCall.init.headers['X-Acting-User-Id'],
        '01USER000000000000000000000',
      );
      assert.equal(
        sandboxCall.init.headers['X-Acting-Organization-Id'],
        '01ORG0000000000000000000000',
      );
      assert.deepEqual(JSON.parse(sandboxCall.init.body), {
        artifact_id: '01ARTIFACT00000000000000000',
        target_filename: 'report.pdf',
      });
    } finally {
      globalThis.fetch = originalFetch;
      config.AUTH_ENABLED = originalAuth;
    }
  });

  it('validates artifact_id before making upstream calls', async () => {
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      throw new Error('must not fetch');
    };
    const res = new MockResponse();
    try {
      await handleImportArtifact('conversation_target', {}, res, { headers: {} });
      assert.equal(res.status, 400);
      assert.equal(JSON.parse(res.body).code, 'artifact_id_required');
      assert.equal(called, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('preserves a structured owner-scoped Sandbox rejection', async () => {
    const originalFetch = globalThis.fetch;
    const originalAuth = config.AUTH_ENABLED;
    globalThis.fetch = async (url) => {
      const value = String(url);
      if (value.endsWith('/internal/sessions/ensure')) {
        return jsonResponse({
          conversation_id: 'conversation_target',
          session_id: 'session_target',
          workspace_id: 'workspace_target',
        });
      }
      if (value.endsWith('/internal/sessions/session_target')) {
        return jsonResponse({
          conversation_id: 'conversation_target',
          session_id: 'session_target',
          workspace_id: 'workspace_target',
          org_id: '01ORG0000000000000000000000',
          user_id: '01USER000000000000000000000',
        });
      }
      if (value.endsWith('/sessions/workspace_target/artifacts/imports')) {
        return jsonResponse(
          {
            detail: {
              code: 'artifact_not_found',
              message: 'Artifact not found',
            },
          },
          404,
        );
      }
      throw new Error(`Unexpected fetch: ${value}`);
    };
    config.AUTH_ENABLED = false;
    const res = new MockResponse();
    try {
      await handleImportArtifact(
        'conversation_target',
        { artifact_id: 'missing-artifact' },
        res,
        { headers: {} },
      );
      assert.equal(res.status, 404);
      assert.deepEqual(JSON.parse(res.body), {
        error: 'Artifact not found',
        code: 'artifact_not_found',
      });
    } finally {
      globalThis.fetch = originalFetch;
      config.AUTH_ENABLED = originalAuth;
    }
  });
});

describe('artifact list proxy', () => {
  // Sandbox 公共面的 `/sessions/:id/...` 里那个 `:id` 是 workspace_id。
  // 列表以前直接透传浏览器给的 sandbox session id，于是 exec 端按错的键查，
  // MCP facade 提交的产物在 UI 上永远看不到（2026-09-03）。
  it('resolves workspace_id before the Sandbox hop', async () => {
    const originalFetch = globalThis.fetch;
    const originalAuth = config.AUTH_ENABLED;
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
      const value = String(url);
      calls.push({ url: value, init });
      if (value.endsWith('/internal/sessions/session_target')) {
        return jsonResponse({
          conversation_id: 'conversation_target',
          session_id: 'session_target',
          workspace_id: 'workspace_target',
          org_id: '01ORG0000000000000000000000',
          user_id: '01USER000000000000000000000',
        });
      }
      if (value.endsWith('/sessions/workspace_target/artifacts')) {
        return jsonResponse({ artifacts: [{ artifact_id: 'a1' }], total: 1 });
      }
      throw new Error(`unexpected fetch: ${value}`);
    };
    config.AUTH_ENABLED = false;
    const res = new MockResponse();
    try {
      await handleListArtifacts(
        new URL('http://bff/api/artifacts?session_id=session_target'),
        res,
        { headers: {} },
      );
      assert.equal(res.status, 200);
      assert.deepEqual(JSON.parse(res.body), {
        artifacts: [{ artifact_id: 'a1' }],
        total: 1,
      });
      assert.ok(
        calls.some((call) => call.url.endsWith('/sessions/workspace_target/artifacts')),
        'Sandbox 跳转必须用 workspace_id，不能透传 session_id',
      );
      assert.equal(
        calls.some((call) => call.url.endsWith('/sessions/session_target/artifacts')),
        false,
      );
    } finally {
      globalThis.fetch = originalFetch;
      config.AUTH_ENABLED = originalAuth;
    }
  });

  it('fails closed when Agent does not return a workspace_id', async () => {
    const originalFetch = globalThis.fetch;
    const originalAuth = config.AUTH_ENABLED;
    globalThis.fetch = async (url) => {
      const value = String(url);
      if (value.endsWith('/internal/sessions/session_target')) {
        return jsonResponse({
          conversation_id: 'conversation_target',
          session_id: 'session_target',
          org_id: '01ORG0000000000000000000000',
          user_id: '01USER000000000000000000000',
        });
      }
      throw new Error(`unexpected fetch: ${value}`);
    };
    config.AUTH_ENABLED = false;
    const res = new MockResponse();
    try {
      await handleListArtifacts(
        new URL('http://bff/api/artifacts?session_id=session_target'),
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
