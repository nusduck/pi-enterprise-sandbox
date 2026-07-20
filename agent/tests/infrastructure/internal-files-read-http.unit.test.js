/**
 * PR-07B: Agent internal HTTP transport for POST /internal/v1/files/read.
 * Offline unit/contract tests — no network, no npm install.
 */

import { createHash, createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  FILES_READ_HTU,
  FILES_READ_SCOPE,
  FILES_READ_TOOL_NAME,
  SKILLS_READ_HTU,
  SKILLS_READ_SCOPE,
  READ_MAX_BYTES_FIXED,
  buildFilesReadBodyBytes,
  createInternalFilesReadTransport,
  createInternalSkillsReadTransport,
  extractCompactJwtPayloadJti,
  filterFilesReadSuccessResult,
  InternalSandboxTransportError,
  normalizeBaseUrl,
  validateAndNormalizeReadFilePayload,
} from '../../src/infrastructure/sandbox/internal-files-read-http.js';
import {
  issueInternalToken,
  verifyInternalToken,
  INTERNAL_TOKEN_CLAIM_KEYS,
} from '../../src/infrastructure/sandbox/internal-hmac.js';
import { computeToolRequestHashV1 } from '../../src/domain/tool/tool-request-hash.js';
import { createSandboxBridgeToolDefinitions } from '../../src/extensions/index.js';

const KEY_BYTES = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const KEY = KEY_BYTES.toString('base64url');
const KEYRING = Object.freeze({ '2026-07': KEY });
const NOW = 1_700_000_000;

/** Default allowed http base (literal loopback). */
const BASE = 'http://127.0.0.1:8081';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';
const CONV = '01K0G2PAV8FPMVC9QHJG7JPN51';
const AGENT = '01K0G2PAV8FPMVC9QHJG7JPN52';
const RUN = '01K0G2PAV8FPMVC9QHJG7JPN53';
const SBX = '01K0G2PAV8FPMVC9QHJG7JPN55';
const TE = '01K0G2PAV8FPMVC9QHJG7JPN5K';
const TC = 'tc-read-1';
const TRACE = '0123456789abcdef0123456789abcdef';
const PATH = '/home/sandbox/workspace/notes/a.txt';
const FENCE = 7;

function requestHash(overrides = {}) {
  const args = {
    path: PATH,
    offset: 0,
    limit: 100,
    maxBytes: READ_MAX_BYTES_FIXED,
    ...overrides,
  };
  return computeToolRequestHashV1({
    toolName: 'read',
    args,
  }).requestHash;
}

function basePayload(overrides = {}) {
  const h = overrides.requestHash ?? requestHash();
  return {
    path: PATH,
    offset: 0,
    limit: 100,
    maxBytes: READ_MAX_BYTES_FIXED,
    identity: {
      orgId: ORG,
      userId: USER,
      conversationId: CONV,
      agentSessionId: AGENT,
      runId: RUN,
      sandboxSessionId: SBX,
      traceId: TRACE,
      executionFenceToken: FENCE,
    },
    toolExecutionId: TE,
    toolCallId: TC,
    requestHash: h,
    requestHashVersion: 1,
    ...overrides,
    identity: {
      orgId: ORG,
      userId: USER,
      conversationId: CONV,
      agentSessionId: AGENT,
      runId: RUN,
      sandboxSessionId: SBX,
      traceId: TRACE,
      executionFenceToken: FENCE,
      ...(overrides.identity || {}),
    },
  };
}

function successBody(overrides = {}) {
  return {
    path: PATH,
    binary: false,
    content: 'ok\n',
    truncated: false,
    offset: 0,
    limit: 100,
    size: 3,
    returnedLines: 1,
    nextOffset: null,
    mimeType: 'text/plain',
    ...overrides,
  };
}

function mockResponse({
  status = 200,
  body,
  contentType = 'application/json',
  headers = {},
  onBodyRead,
} = {}) {
  const raw =
    body == null
      ? Buffer.alloc(0)
      : Buffer.isBuffer(body)
        ? body
        : Buffer.from(
            typeof body === 'string' ? body : JSON.stringify(body),
            'utf8',
          );
  const h = new Headers({
    'content-type': contentType,
    'content-length': String(raw.byteLength),
    ...headers,
  });
  return {
    status,
    headers: h,
    body: {
      getReader() {
        let done = false;
        return {
          async read() {
            if (typeof onBodyRead === 'function') {
              await onBodyRead();
            }
            if (done) return { done: true, value: undefined };
            done = true;
            return { done: false, value: new Uint8Array(raw) };
          },
          async cancel() {},
        };
      },
    },
    async arrayBuffer() {
      if (typeof onBodyRead === 'function') await onBodyRead();
      return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    },
  };
}

function decodeJwtClaims(token) {
  const seg = token.split('.')[1];
  return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
}

/**
 * Minimal compact JWT with given jti (for tokenIssuer tests).
 * @param {string} jti
 * @param {object} [claimOverrides]
 */
function compactTokenWithJti(jti, claimOverrides = {}) {
  const header = { alg: 'HS256', kid: '2026-07', typ: 'sandbox-internal+jwt' };
  const claims = {
    token_version: 1,
    jti,
    ...claimOverrides,
  };
  const h = Buffer.from(JSON.stringify(header)).toString('base64url');
  const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const sig = createHmac('sha256', KEY_BYTES)
    .update(`${h}.${p}`, 'ascii')
    .digest('base64url');
  return `${h}.${p}.${sig}`;
}

function transportOpts(overrides = {}) {
  return {
    baseUrl: BASE,
    keyring: KEYRING,
    activeKid: '2026-07',
    clock: () => NOW,
    randomBytes: () => new Uint8Array(16).fill(1),
    ...overrides,
  };
}

function assertOutcomeUnknown(err) {
  assert.ok(err instanceof InternalSandboxTransportError);
  assert.equal(err.code, 'TOOL_OUTCOME_UNKNOWN');
  assert.equal(err.outcomeUnknown, true);
  assert.equal(err.retryable, false);
}

describe('files.read body contract (Agent ↔ Python parity)', () => {
  it('builds compact body with exact keys and matching requestHash', () => {
    const payload = basePayload();
    const { bodyBytes, bodySha256, normalized } =
      buildFilesReadBodyBytes(payload);

    const parsed = JSON.parse(bodyBytes.toString('utf8'));
    assert.deepEqual(Object.keys(parsed), [
      'path',
      'offset',
      'limit',
      'maxBytes',
      'identity',
      'toolExecutionId',
      'toolCallId',
      'requestHash',
      'requestHashVersion',
    ]);
    assert.deepEqual(Object.keys(parsed.identity), [
      'orgId',
      'userId',
      'conversationId',
      'agentSessionId',
      'runId',
      'sandboxSessionId',
      'traceId',
      'executionFenceToken',
    ]);
    assert.equal(parsed.maxBytes, 262144);
    assert.equal(parsed.requestHash, requestHash());
    assert.equal(
      bodySha256,
      createHash('sha256').update(bodyBytes).digest('hex'),
    );
    assert.equal(normalized.toolExecutionId, TE);
    assert.equal(bodyBytes.includes(0x20), false);
  });

  it('rejects model fields overriding identity/claim via rebuild', () => {
    const payload = basePayload({
      extra: 'nope',
      orgId: 'attacker',
    });
    const { bodyBytes } = buildFilesReadBodyBytes(payload);
    const parsed = JSON.parse(bodyBytes.toString('utf8'));
    assert.equal('extra' in parsed, false);
    assert.equal(parsed.identity.orgId, ORG);
    assert.equal(Object.keys(parsed).includes('orgId'), false);
  });

  it('rejects requestHash mismatch with recomputed semantic hash', () => {
    assert.throws(
      () =>
        buildFilesReadBodyBytes(basePayload({ requestHash: 'ab'.repeat(32) })),
      (e) =>
        e instanceof InternalSandboxTransportError &&
        e.code === 'FILES_READ_HASH',
    );
  });

  it('rejects non-workspace path', () => {
    assert.throws(
      () =>
        buildFilesReadBodyBytes(
          basePayload({
            path: '/home/sandbox/skill/x.md',
            requestHash: requestHash({
              path: '/home/sandbox/skill/x.md',
            }),
          }),
        ),
      (e) => e.code === 'FILES_READ_PATH',
    );
  });

  it('cross-checks body_sha256 + issueInternalToken claims for Python verifier', () => {
    const { bodyBytes, bodySha256, normalized } = buildFilesReadBodyBytes(
      basePayload(),
    );
    const jtiBytes = Uint8Array.from(
      Array.from({ length: 16 }, (_, i) => i + 1),
    );
    const token = issueInternalToken({
      keyring: KEYRING,
      activeKid: '2026-07',
      claims: {
        org_id: normalized.identity.orgId,
        user_id: normalized.identity.userId,
        conversation_id: normalized.identity.conversationId,
        agent_session_id: normalized.identity.agentSessionId,
        sandbox_session_id: normalized.identity.sandboxSessionId,
        run_id: normalized.identity.runId,
        tool_execution_id: normalized.toolExecutionId,
        tool_call_id: normalized.toolCallId,
        tool_name: FILES_READ_TOOL_NAME,
        scope: [FILES_READ_SCOPE],
        request_hash: normalized.requestHash,
        execution_fence_token: normalized.identity.executionFenceToken,
        trace_id: normalized.identity.traceId,
        htm: 'POST',
        htu: FILES_READ_HTU,
        body_sha256: bodySha256,
      },
      clock: () => NOW,
      randomBytes: () => jtiBytes,
    });
    const claims = verifyInternalToken(token, {
      keyring: KEYRING,
      clock: () => NOW,
    });
    assert.deepEqual(Object.keys(claims), [...INTERNAL_TOKEN_CLAIM_KEYS]);
    assert.equal(claims.htm, 'POST');
    assert.equal(claims.htu, '/internal/v1/files/read');
    assert.equal(claims.tool_name, 'read');
    assert.deepEqual(claims.scope, ['sandbox.files.read']);
    assert.equal(claims.body_sha256, bodySha256);
    assert.equal(
      claims.body_sha256,
      createHash('sha256').update(bodyBytes).digest('hex'),
    );
    assert.equal(claims.request_hash, normalized.requestHash);
    assert.equal(claims.request_hash_version, 1);
  });
});

describe('normalizeBaseUrl http policy', () => {
  it('accepts https always', () => {
    assert.equal(
      normalizeBaseUrl('https://sandbox.internal:8081/'),
      'https://sandbox.internal:8081',
    );
  });

  it('accepts literal loopback http without allowInsecureHttp', () => {
    assert.equal(normalizeBaseUrl('http://127.0.0.1:8081'), 'http://127.0.0.1:8081');
    assert.equal(normalizeBaseUrl('http://localhost:8081'), 'http://localhost:8081');
    assert.equal(normalizeBaseUrl('http://[::1]:8081'), 'http://[::1]:8081');
  });

  it('rejects external http by default', () => {
    assert.throws(
      () => normalizeBaseUrl('http://sandbox.example.com:8081'),
      (e) => e.code === 'SANDBOX_TRANSPORT_CONFIG',
    );
    assert.throws(
      () => normalizeBaseUrl('http://10.0.0.5:8081'),
      (e) => e.code === 'SANDBOX_TRANSPORT_CONFIG',
    );
    assert.throws(
      () => createInternalFilesReadTransport({
        baseUrl: 'http://sandbox.test:8081',
        keyring: KEYRING,
        activeKid: '2026-07',
      }),
      (e) => e.code === 'SANDBOX_TRANSPORT_CONFIG',
    );
  });

  it('accepts external http only with allowInsecureHttp=true', () => {
    assert.equal(
      normalizeBaseUrl('http://sandbox.example.com:8081', {
        allowInsecureHttp: true,
      }),
      'http://sandbox.example.com:8081',
    );
    const t = createInternalFilesReadTransport({
      baseUrl: 'http://sandbox.example.com:8081',
      allowInsecureHttp: true,
      keyring: KEYRING,
      activeKid: '2026-07',
      fetchImpl: async () => mockResponse({ status: 200, body: successBody() }),
      clock: () => NOW,
      randomBytes: () => new Uint8Array(16).fill(9),
    });
    assert.equal(t._url, 'http://sandbox.example.com:8081/internal/v1/files/read');
  });
});

describe('createInternalFilesReadTransport.readFile', () => {
  it('200 success: filters shape and uses exact body + single Bearer', async () => {
    /** @type {Array<object>} */
    const calls = [];
    let jtiN = 0;
    const transport = createInternalFilesReadTransport(
      transportOpts({
        randomBytes: (size) => {
          assert.equal(size, 16);
          jtiN += 1;
          return Uint8Array.from(
            Array.from({ length: 16 }, (_, i) => jtiN * 10 + i),
          );
        },
        fetchImpl: async (url, init) => {
          calls.push({ url, init });
          return mockResponse({ status: 200, body: successBody() });
        },
      }),
    );

    const result = await transport.readFile(basePayload());
    assert.equal(result.content, 'ok\n');
    assert.equal(result.path, PATH);
    assert.equal('hostPath' in result, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${BASE}/internal/v1/files/read`);
    assert.equal(calls[0].init.method, 'POST');

    const headers = calls[0].init.headers;
    const authKeys = Object.keys(headers).filter(
      (k) => k.toLowerCase() === 'authorization',
    );
    assert.equal(authKeys.length, 1);
    assert.match(headers.Authorization, /^Bearer\s+\S+$/);
    assert.equal(headers['X-API-Key'], undefined);
    assert.equal(headers['Content-Type'], 'application/json');
    assert.equal(headers['X-Trace-Id'], TRACE);
    assert.match(
      headers.traceparent,
      new RegExp(`^00-${TRACE}-[0-9a-f]{16}-01$`),
    );

    const bodyBuf = Buffer.from(calls[0].init.body);
    const expected = buildFilesReadBodyBytes(basePayload());
    assert.deepEqual(bodyBuf, expected.bodyBytes);

    const claims = decodeJwtClaims(
      headers.Authorization.slice('Bearer '.length),
    );
    assert.equal(claims.body_sha256, expected.bodySha256);
    assert.equal(claims.htu, FILES_READ_HTU);
    assert.equal(claims.tool_name, 'read');
    assert.deepEqual(claims.scope, ['sandbox.files.read']);
  });

  it('strips arbitrary 200 fields (fail-closed filter)', async () => {
    const transport = createInternalFilesReadTransport(
      transportOpts({
        fetchImpl: async () =>
          mockResponse({
            status: 200,
            body: {
              ...successBody(),
              hostPath: '/var/lib/workspaces/secret',
              internalDebug: true,
            },
          }),
      }),
    );
    const result = await transport.readFile(basePayload());
    assert.equal('hostPath' in result, false);
    assert.equal('internalDebug' in result, false);
    assert.equal(result.content, 'ok\n');
  });

  it('retry: new jti each attempt, identical body bytes', async () => {
    /** @type {string[]} */
    const bodies = [];
    /** @type {string[]} */
    const jtis = [];
    let attempt = 0;
    const transport = createInternalFilesReadTransport(
      transportOpts({
        maxAttempts: 3,
        randomBytes: (size) => {
          attempt += 1;
          return Uint8Array.from(
            Array.from({ length: size }, (_, i) => attempt + i),
          );
        },
        fetchImpl: async (_url, init) => {
          bodies.push(Buffer.from(init.body).toString('base64'));
          const token = init.headers.Authorization.slice('Bearer '.length);
          jtis.push(decodeJwtClaims(token).jti);
          if (jtis.length < 2) {
            return mockResponse({
              status: 503,
              body: { detail: 'Service temporarily unavailable' },
            });
          }
          return mockResponse({ status: 200, body: successBody() });
        },
      }),
    );

    await transport.readFile(basePayload());
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0], bodies[1]);
    assert.notEqual(jtis[0], jtis[1]);
  });

  it('does not auto-retry 409 IN_PROGRESS', async () => {
    let calls = 0;
    const transport = createInternalFilesReadTransport(
      transportOpts({
        maxAttempts: 3,
        randomBytes: () => new Uint8Array(16).fill(2),
        fetchImpl: async () => {
          calls += 1;
          return mockResponse({
            status: 409,
            body: {
              detail: {
                code: 'IN_PROGRESS',
                message: 'Tool execution in progress',
              },
            },
          });
        },
      }),
    );
    await assert.rejects(
      () => transport.readFile(basePayload()),
      (e) =>
        e instanceof InternalSandboxTransportError &&
        e.code === 'IN_PROGRESS' &&
        e.httpStatus === 409 &&
        e.outcomeUnknown !== true,
    );
    assert.equal(calls, 1);
  });

  it('409 TOOL_OUTCOME_UNKNOWN carries outcomeUnknown marker; no retry', async () => {
    let calls = 0;
    const transport = createInternalFilesReadTransport(
      transportOpts({
        maxAttempts: 3,
        randomBytes: () => new Uint8Array(16).fill(3),
        fetchImpl: async () => {
          calls += 1;
          return mockResponse({
            status: 409,
            body: {
              detail: {
                code: 'TOOL_OUTCOME_UNKNOWN',
                message: 'Tool outcome unknown',
              },
            },
          });
        },
      }),
    );
    await assert.rejects(
      () => transport.readFile(basePayload()),
      (e) => {
        assertOutcomeUnknown(e);
        assert.equal(e.httpStatus, 409);
        return true;
      },
    );
    assert.equal(calls, 1);
  });

  it('does not auto-retry 409 CANCELLED', async () => {
    let calls = 0;
    const transport = createInternalFilesReadTransport(
      transportOpts({
        maxAttempts: 3,
        randomBytes: () => new Uint8Array(16).fill(4),
        fetchImpl: async () => {
          calls += 1;
          return mockResponse({
            status: 409,
            body: {
              detail: {
                code: 'CANCELLED',
                message: 'Tool execution cancelled',
              },
            },
          });
        },
      }),
    );
    await assert.rejects(
      () => transport.readFile(basePayload()),
      (e) => e.code === 'CANCELLED' && e.outcomeUnknown !== true,
    );
    assert.equal(calls, 1);
  });

  it('preserves business error envelope codes (FILE_NOT_FOUND)', async () => {
    const transport = createInternalFilesReadTransport(
      transportOpts({
        maxAttempts: 2,
        randomBytes: () => new Uint8Array(16).fill(5),
        fetchImpl: async () =>
          mockResponse({
            status: 404,
            body: {
              error: { code: 'FILE_NOT_FOUND', message: 'File not found' },
            },
          }),
      }),
    );
    await assert.rejects(
      () => transport.readFile(basePayload()),
      (e) => e.code === 'FILE_NOT_FOUND' && e.httpStatus === 404,
    );
  });

  it('post-dispatch timeout → TOOL_OUTCOME_UNKNOWN + outcomeUnknown (no retry)', async () => {
    let calls = 0;
    const transport = createInternalFilesReadTransport(
      transportOpts({
        attemptTimeoutMs: 20,
        totalTimeoutMs: 50,
        maxAttempts: 3,
        randomBytes: () => new Uint8Array(16).fill(6),
        fetchImpl: async (_url, init) => {
          calls += 1;
          await new Promise((_, reject) => {
            init.signal.addEventListener(
              'abort',
              () => {
                const err = new Error('aborted');
                err.name = 'AbortError';
                reject(err);
              },
              { once: true },
            );
          });
        },
      }),
    );
    await assert.rejects(
      () => transport.readFile(basePayload()),
      (e) => {
        assertOutcomeUnknown(e);
        return true;
      },
    );
    assert.equal(calls, 1);
  });

  it('pre-send cancel → SANDBOX_CANCELLED (not UNKNOWN)', async () => {
    const ac = new AbortController();
    ac.abort();
    const transport = createInternalFilesReadTransport(
      transportOpts({
        signal: ac.signal,
        fetchImpl: async () => {
          throw new Error('fetch must not be called');
        },
      }),
    );
    await assert.rejects(
      () => transport.readFile(basePayload()),
      (e) =>
        e.code === 'SANDBOX_CANCELLED' &&
        e.outcomeUnknown !== true,
    );
  });

  it('post-dispatch external abort → TOOL_OUTCOME_UNKNOWN', async () => {
    const ac = new AbortController();
    let calls = 0;
    const transport = createInternalFilesReadTransport(
      transportOpts({
        signal: ac.signal,
        maxAttempts: 2,
        randomBytes: () => new Uint8Array(16).fill(11),
        fetchImpl: async (_url, init) => {
          calls += 1;
          return new Promise((_, reject) => {
            init.signal.addEventListener(
              'abort',
              () => {
                const err = new Error('aborted');
                err.name = 'AbortError';
                reject(err);
              },
              { once: true },
            );
            // Abort after dispatch
            queueMicrotask(() => ac.abort());
          });
        },
      }),
    );
    await assert.rejects(
      () => transport.readFile(basePayload()),
      (e) => {
        assertOutcomeUnknown(e);
        return true;
      },
    );
    assert.equal(calls, 1);
  });

  it('response body read interrupt → TOOL_OUTCOME_UNKNOWN', async () => {
    const transport = createInternalFilesReadTransport(
      transportOpts({
        maxAttempts: 2,
        randomBytes: () => new Uint8Array(16).fill(12),
        fetchImpl: async () =>
          mockResponse({
            status: 200,
            body: successBody(),
            onBodyRead: async () => {
              const err = new Error('stream reset');
              err.code = 'ECONNRESET';
              throw err;
            },
          }),
      }),
    );
    await assert.rejects(
      () => transport.readFile(basePayload()),
      (e) => {
        assertOutcomeUnknown(e);
        return true;
      },
    );
  });

  it('ambiguous network after dispatch → TOOL_OUTCOME_UNKNOWN (no retry)', async () => {
    let calls = 0;
    const transport = createInternalFilesReadTransport(
      transportOpts({
        maxAttempts: 3,
        randomBytes: () => new Uint8Array(16).fill(13),
        fetchImpl: async () => {
          calls += 1;
          const err = new Error('socket hang up');
          err.code = 'ECONNRESET';
          throw err;
        },
      }),
    );
    await assert.rejects(
      () => transport.readFile(basePayload()),
      (e) => {
        assertOutcomeUnknown(e);
        return true;
      },
    );
    assert.equal(calls, 1);
  });

  it('rejects oversized response fail-closed', async () => {
    const transport = createInternalFilesReadTransport(
      transportOpts({
        maxResponseBytes: 64,
        randomBytes: () => new Uint8Array(16).fill(7),
        fetchImpl: async () =>
          mockResponse({
            status: 200,
            body: successBody({ content: 'x'.repeat(200) }),
          }),
      }),
    );
    await assert.rejects(
      () => transport.readFile(basePayload()),
      (e) => e.code === 'SANDBOX_RESPONSE_TOO_LARGE',
    );
  });

  it('rejects non-JSON / wrong Content-Type on 200', async () => {
    const transport = createInternalFilesReadTransport(
      transportOpts({
        randomBytes: () => new Uint8Array(16).fill(8),
        fetchImpl: async () =>
          mockResponse({
            status: 200,
            body: 'not-json',
            contentType: 'text/plain',
          }),
      }),
    );
    await assert.rejects(
      () => transport.readFile(basePayload()),
      (e) => e.code === 'SANDBOX_RESPONSE_INVALID',
    );
  });

  it('malformed JSON 200 fails closed without leaking body', async () => {
    const transport = createInternalFilesReadTransport(
      transportOpts({
        randomBytes: () => new Uint8Array(16).fill(9),
        fetchImpl: async () =>
          mockResponse({
            status: 200,
            body: '{not-json',
            contentType: 'application/json',
          }),
      }),
    );
    await assert.rejects(
      () => transport.readFile(basePayload()),
      (e) => {
        assert.equal(e.code, 'SANDBOX_RESPONSE_INVALID');
        assert.equal(String(e.message).includes('{not-json'), false);
        assert.equal(String(e.message).includes('127.0.0.1'), false);
        return true;
      },
    );
  });

  it('default maxAttempts is 1 (no 503 retry)', async () => {
    let calls = 0;
    const transport = createInternalFilesReadTransport(
      transportOpts({
        randomBytes: () => new Uint8Array(16).fill(10),
        fetchImpl: async () => {
          calls += 1;
          return mockResponse({
            status: 503,
            body: { detail: 'unavailable' },
          });
        },
      }),
    );
    await assert.rejects(() => transport.readFile(basePayload()));
    assert.equal(calls, 1);
  });

  it('tokenIssuer must embed expectedJti; two attempts get different jtis', async () => {
    /** @type {string[]} */
    const expected = [];
    /** @type {string[]} */
    const wireJtis = [];
    let n = 0;
    const transport = createInternalFilesReadTransport({
      baseUrl: BASE,
      clock: () => NOW,
      maxAttempts: 2,
      randomBytes: (size) => {
        n += 1;
        return Uint8Array.from(
          Array.from({ length: size }, (_, i) => n * 3 + i),
        );
      },
      tokenIssuer: async (claims, meta) => {
        assert.equal(typeof meta.expectedJti, 'string');
        assert.equal(typeof meta.attempt, 'number');
        expected.push(meta.expectedJti);
        assert.equal(claims.tool_name, 'read');
        assert.equal(claims.htu, FILES_READ_HTU);
        return compactTokenWithJti(meta.expectedJti, {
          body_sha256: meta.bodySha256,
        });
      },
      fetchImpl: async (_url, init) => {
        const token = init.headers.Authorization.slice('Bearer '.length);
        wireJtis.push(extractCompactJwtPayloadJti(token));
        if (wireJtis.length < 2) {
          return mockResponse({
            status: 503,
            body: { detail: 'unavailable' },
          });
        }
        return mockResponse({ status: 200, body: successBody() });
      },
    });
    await transport.readFile(basePayload());
    assert.equal(expected.length, 2);
    assert.notEqual(expected[0], expected[1]);
    assert.deepEqual(wireJtis, expected);
  });

  it('tokenIssuer reusing jti fails closed before second send', async () => {
    let issueCount = 0;
    let fetchCount = 0;
    let firstJti = null;
    const transport = createInternalFilesReadTransport({
      baseUrl: BASE,
      clock: () => NOW,
      maxAttempts: 2,
      randomBytes: (size) => {
        issueCount += 1;
        return Uint8Array.from(
          Array.from({ length: size }, (_, i) => issueCount * 7 + i),
        );
      },
      tokenIssuer: async (_claims, meta) => {
        if (firstJti == null) {
          firstJti = meta.expectedJti;
          return compactTokenWithJti(meta.expectedJti);
        }
        // Malicious reuse of first jti on second attempt
        return compactTokenWithJti(firstJti);
      },
      fetchImpl: async () => {
        fetchCount += 1;
        return mockResponse({
          status: 503,
          body: { detail: 'unavailable' },
        });
      },
    });
    await assert.rejects(
      () => transport.readFile(basePayload()),
      (e) => e.code === 'SANDBOX_TOKEN_JTI_MISMATCH',
    );
    // First attempt sent; second attempt failed before fetch.
    assert.equal(fetchCount, 1);
  });

  it('tokenIssuer returning non-JWT fails closed before send', async () => {
    let fetchCount = 0;
    const transport = createInternalFilesReadTransport({
      baseUrl: BASE,
      clock: () => NOW,
      randomBytes: () => new Uint8Array(16).fill(20),
      tokenIssuer: async () => 'not-a-jwt',
      fetchImpl: async () => {
        fetchCount += 1;
        return mockResponse({ status: 200, body: successBody() });
      },
    });
    await assert.rejects(
      () => transport.readFile(basePayload()),
      (e) => e.code === 'SANDBOX_TOKEN_INVALID',
    );
    assert.equal(fetchCount, 0);
  });

  it('filterFilesReadSuccessResult rejects path mismatch', () => {
    assert.throws(
      () =>
        filterFilesReadSuccessResult(
          successBody({ path: '/home/sandbox/workspace/other.txt' }),
          {
            path: PATH,
            offset: 0,
            limit: 100,
            maxBytes: READ_MAX_BYTES_FIXED,
          },
        ),
      (e) => e.code === 'SANDBOX_RESPONSE_INVALID',
    );
  });

  it('validateAndNormalizeReadFilePayload rejects non-ULID toolExecutionId', () => {
    assert.throws(
      () =>
        validateAndNormalizeReadFilePayload(
          basePayload({ toolExecutionId: 'not-a-ulid' }),
        ),
      (e) => e.code === 'FILES_READ_PAYLOAD_INVALID',
    );
  });
});

describe('createInternalSkillsReadTransport.readFile', () => {
  it('uses the Skill route and scope while preserving the read ledger contract', async () => {
    const calls = [];
    const skillPath = '/home/sandbox/skill/pdf/SKILL.md';
    const payload = basePayload({
      path: skillPath,
      requestHash: requestHash({ path: skillPath }),
    });
    const transport = createInternalSkillsReadTransport({
      baseUrl: BASE,
      keyring: KEYRING,
      activeKid: '2026-07',
      clock: () => NOW,
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return mockResponse({ body: successBody({ path: skillPath }) });
      },
    });

    await transport.readFile(payload);
    assert.equal(calls[0].url, `${BASE}${SKILLS_READ_HTU}`);
    const claims = verifyInternalToken(calls[0].init.headers.Authorization.slice(7), {
      keyring: KEYRING,
      clock: () => NOW,
    });
    assert.deepEqual(claims.scope, [SKILLS_READ_SCOPE]);
  });
});

describe('mapTransportError preserves codes + UNKNOWN marker', () => {
  const runContext = Object.freeze({
    orgId: ORG,
    userId: USER,
    conversationId: CONV,
    agentSessionId: AGENT,
    runId: RUN,
    sandboxSessionId: SBX,
    traceId: TRACE,
    executionFenceToken: FENCE,
  });

  function toolsWithThrow(code, extra = {}) {
    const transport = {
      readFile: async () => {
        const err = new Error(`sandbox: ${code}`);
        err.code = code;
        if (extra.outcomeUnknown === true) err.outcomeUnknown = true;
        throw err;
      },
      writeFile: async () => {},
      editFile: async () => {},
      bash: async () => {},
      python: async () => {},
      processStart: async () => {},
      processStatus: async () => {},
      processRead: async () => {},
      processKill: async () => {},
      submitArtifact: async () => {},
    };
    return createSandboxBridgeToolDefinitions(runContext, transport, {
      sandboxRequestBinder: {
        async bindSandboxRequest() {
          return {
            toolExecutionId: TE,
            requestHash: 'a'.repeat(64),
            requestHashVersion: 1,
            bound: true,
          };
        },
      },
    });
  }

  it('TOOL_OUTCOME_UNKNOWN sets exact outcomeUnknown:true marker only', async () => {
    const defs = toolsWithThrow('TOOL_OUTCOME_UNKNOWN', {
      outcomeUnknown: true,
    });
    const read = defs.find((t) => t.name === 'read');
    const result = await read.execute('tc-map-1', {
      path: 'notes/a.txt',
      offset: 0,
      limit: 100,
    });
    assert.equal(result.details?.code, 'TOOL_OUTCOME_UNKNOWN');
    assert.equal(result.details?.outcomeUnknown, true);
    // No arbitrary fields
    assert.equal(result.details?.httpStatus, undefined);
    assert.equal(result.details?.stack, undefined);
  });

  it('code TOOL_OUTCOME_UNKNOWN without flag still gets marker', async () => {
    const defs = toolsWithThrow('TOOL_OUTCOME_UNKNOWN');
    const read = defs.find((t) => t.name === 'read');
    const result = await read.execute('tc-map-1b', {
      path: 'notes/a.txt',
    });
    assert.equal(result.details?.code, 'TOOL_OUTCOME_UNKNOWN');
    assert.equal(result.details?.outcomeUnknown, true);
  });

  for (const code of ['IN_PROGRESS', 'CANCELLED']) {
    it(`preserves ${code} without outcomeUnknown marker`, async () => {
      const defs = toolsWithThrow(code);
      const read = defs.find((t) => t.name === 'read');
      const result = await read.execute(`tc-map-${code}`, {
        path: 'notes/a.txt',
        offset: 0,
        limit: 100,
      });
      assert.equal(result.details?.code, code);
      assert.equal(result.details?.outcomeUnknown, undefined);
    });
  }

  it('still remaps bare UNKNOWN to SANDBOX_ERROR without marker', async () => {
    const defs = toolsWithThrow('UNKNOWN');
    const read = defs.find((t) => t.name === 'read');
    const result = await read.execute('tc-map-2', {
      path: 'notes/a.txt',
    });
    assert.equal(result.details?.code, 'SANDBOX_ERROR');
    assert.equal(result.details?.outcomeUnknown, undefined);
  });
});
