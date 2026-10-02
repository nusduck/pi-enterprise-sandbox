/**
 * BFF → Agent 错误透传（C5 A1，关闭 review-deferred-items「保存期校验失败的
 * 具体错误码在 BFF 被丢弃」）。
 *
 * agent 保存版本时字段级错误返回 400
 * `{ error, code: "VALIDATION_ERROR", reason_code }`（docs/api.md 有约）；
 * BFF 必须把 `reason_code` 原样带回给浏览器，状态码与既有映射保持不变。
 *
 * Run: npx tsx --test tests/agent-error-propagation.test.js
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

const originalFetch = globalThis.fetch;
const originalEnv = {
  AGENT_BASE_URL: process.env.AGENT_BASE_URL,
  AUTH_ENABLED: process.env.AUTH_ENABLED,
};

process.env.AGENT_BASE_URL = 'http://agent.error.test';
process.env.AUTH_ENABLED = 'true';

const { handleCreateAgentVersion } = await import(`../src/routes/agents.js?test=${Date.now()}`);
const { createAgentDefinitionVersion } = await import(`../src/services/agent-catalog-client.js?test=${Date.now()}`);

const ME = '01K0G2PAV8FPMVC9QHJG7JPN50';
const ORG = '01K0G2PAV8FPMVC9QHJG7JPN51';
const AGENT = '01K0G2PAV8FPMVC9QHJG7JPN60';

function responseCapture() {
  const captured = { statusCode: 0, body: '' };
  return {
    captured,
    response: {
      headersSent: false,
      writeHead(status) {
        captured.statusCode = status;
      },
      end(body) {
        captured.body = body || '';
      },
    },
    json() {
      return captured.body ? JSON.parse(captured.body) : null;
    },
  };
}

const request = () => ({
  method: 'POST',
  headers: { authorization: 'Bearer browser-token' },
  requestId: 'req-1',
  traceId: null,
  on() {},
  removeListener() {},
  resume() {},
});

before(() => {
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/internal/auth/me') {
      return new Response(
        JSON.stringify({ id: ME, organization_id: ORG, username: 'alice', roles: ['admin'] }),
        { status: 200 },
      );
    }
    if (url.pathname === `/internal/agents/${AGENT}/versions`) {
      return new Response(
        JSON.stringify({
          error: 'unknown delegation agent',
          code: 'VALIDATION_ERROR',
          reason_code: 'DELEGATION_AGENT_UNKNOWN',
        }),
        { status: 400 },
      );
    }
    throw new Error(`unexpected agent call: ${url.pathname}`);
  };
});

after(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('agent 错误透传 reason_code', () => {
  it('service 抛出的错误带上 reason_code', async () => {
    await assert.rejects(
      createAgentDefinitionVersion(AGENT, { config: {} }, { auth: null }),
      (error) => {
        assert.equal(error.status, 400);
        assert.equal(error.code, 'VALIDATION_ERROR');
        assert.equal(error.reason_code, 'DELEGATION_AGENT_UNKNOWN');
        return true;
      },
    );
  });

  it('保存版本 400 时 BFF 响应体带同样的 reason_code', async () => {
    const { captured, response, json } = responseCapture();
    await handleCreateAgentVersion(AGENT, { config: {} }, response, request());
    assert.equal(captured.statusCode, 400);
    assert.equal(json().code, 'VALIDATION_ERROR');
    assert.equal(json().reason_code, 'DELEGATION_AGENT_UNKNOWN');
  });
});
