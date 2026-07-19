import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ARTIFACT_DOWNLOAD_HTU,
  ARTIFACT_DOWNLOAD_SCOPE,
  ARTIFACT_DOWNLOAD_TOOL,
  createInternalArtifactDownloadTransport,
  InternalArtifactDownloadError,
} from '../../src/infrastructure/sandbox/internal-artifact-download-http.js';
import { verifyInternalToken } from '../../src/infrastructure/sandbox/internal-hmac.js';

const KEYRING = Object.freeze({
  current: Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)).toString(
    'base64url',
  ),
});
const NOW = 1_900_000_000;
const BASE_URL = 'http://127.0.0.1:8081';
const ARTIFACT_ID = '01K0G2PAV8FPMVC9QHJG7JPN5F';
const BYTES = Buffer.from('owner-scoped-artifact-bytes', 'utf8');
const SHA256 = createHash('sha256').update(BYTES).digest('hex');

const IDENTITY = Object.freeze({
  orgId: '01K0G2PAV8FPMVC9QHJG7JPN4Z',
  userId: '01K0G2PAV8FPMVC9QHJG7JPN50',
  conversationId: '01K0G2PAV8FPMVC9QHJG7JPN51',
  agentSessionId: '01K0G2PAV8FPMVC9QHJG7JPN52',
  runId: '01K0G2PAV8FPMVC9QHJG7JPN53',
  sandboxSessionId: '01K0G2PAV8FPMVC9QHJG7JPN54',
  traceId: '0123456789abcdef0123456789abcdef',
  executionFenceToken: 7,
});

function input(overrides = {}) {
  return {
    artifactId: ARTIFACT_ID,
    identity: { ...IDENTITY },
    expectedSizeBytes: BYTES.byteLength,
    expectedSha256: SHA256,
    ...overrides,
  };
}

function sandboxResponse({
  status = 200,
  artifactId = ARTIFACT_ID,
  sha256 = SHA256,
  contentLength = BYTES.byteLength,
  body = BYTES,
} = {}) {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'application/octet-stream',
      'content-disposition': 'attachment; filename="report.bin"',
      'content-length': String(contentLength),
      'x-artifact-id': artifactId,
      'x-artifact-sha256': sha256,
    },
  });
}

function transportOptions(overrides = {}) {
  return {
    baseUrl: BASE_URL,
    keyring: KEYRING,
    activeKid: 'current',
    clock: () => NOW,
    randomBytes: () => new Uint8Array(16).fill(7),
    ...overrides,
  };
}

describe('internal artifact byte download transport', () => {
  it('binds the exact owner identity and opaque artifact id into the HMAC request', async () => {
    let request = null;
    const transport = createInternalArtifactDownloadTransport(
      transportOptions({
        fetchImpl: async (url, init) => {
          request = { url, init };
          return sandboxResponse();
        },
      }),
    );

    const result = await transport.downloadArtifact(input());

    assert.equal(request.url, `${BASE_URL}${ARTIFACT_DOWNLOAD_HTU}`);
    assert.equal(request.init.method, 'POST');
    assert.equal(request.init.headers['content-type'], 'application/json');
    assert.equal(request.init.headers['X-Trace-Id'], IDENTITY.traceId);
    assert.match(
      request.init.headers.traceparent,
      new RegExp(`^00-${IDENTITY.traceId}-[0-9a-f]{16}-01$`),
    );
    const body = Buffer.from(request.init.body);
    assert.equal(request.init.headers['content-length'], String(body.byteLength));
    const parsed = JSON.parse(body.toString('utf8'));
    assert.deepEqual(Object.keys(parsed), ['artifactId', 'identity']);
    assert.deepEqual(parsed, {
      artifactId: ARTIFACT_ID,
      identity: IDENTITY,
    });
    assert.equal(JSON.stringify(parsed).includes('path'), false);

    const token = request.init.headers.authorization.slice('Bearer '.length);
    const claims = verifyInternalToken(token, {
      keyring: KEYRING,
      clock: () => NOW,
    });
    const bodySha256 = createHash('sha256').update(body).digest('hex');
    const operationId = `${ARTIFACT_ID}:${ARTIFACT_DOWNLOAD_TOOL}`;
    assert.equal(claims.request_hash, bodySha256);
    assert.equal(claims.body_sha256, bodySha256);
    assert.equal(claims.request_hash_version, 1);
    assert.equal(claims.tool_execution_id, operationId);
    assert.equal(claims.tool_call_id, operationId);
    assert.equal(claims.tool_name, ARTIFACT_DOWNLOAD_TOOL);
    assert.deepEqual(claims.scope, [ARTIFACT_DOWNLOAD_SCOPE]);
    assert.equal(claims.htu, ARTIFACT_DOWNLOAD_HTU);
    assert.equal(claims.org_id, IDENTITY.orgId);
    assert.equal(claims.user_id, IDENTITY.userId);
    assert.equal(claims.run_id, IDENTITY.runId);
    assert.equal(claims.sandbox_session_id, IDENTITY.sandboxSessionId);

    assert.equal(
      Buffer.from(await new Response(result.body).arrayBuffer()).toString('utf8'),
      BYTES.toString('utf8'),
    );
    assert.equal(result.contentLength, BYTES.byteLength);
    assert.equal(result.sha256, SHA256);
    assert.equal(result.contentType, 'application/octet-stream');
  });

  it('rejects filesystem paths and malformed owner identities before dispatch', async () => {
    let dispatched = false;
    const transport = createInternalArtifactDownloadTransport(
      transportOptions({
        fetchImpl: async () => {
          dispatched = true;
          return sandboxResponse();
        },
      }),
    );

    await assert.rejects(
      () =>
        transport.downloadArtifact({
          ...input(),
          relativePath: '/home/sandbox/workspace/secret.txt',
        }),
      (error) =>
        error instanceof InternalArtifactDownloadError &&
        error.code === 'ARTIFACT_DOWNLOAD_PAYLOAD_INVALID',
    );
    await assert.rejects(
      () =>
        transport.downloadArtifact(
          input({ identity: { ...IDENTITY, userId: 'external-user' } }),
        ),
      (error) =>
        error instanceof InternalArtifactDownloadError &&
        error.code === 'ARTIFACT_DOWNLOAD_PAYLOAD_INVALID',
    );
    assert.equal(dispatched, false);
  });

  it('forwards a request-scoped tracestate carrier to Sandbox', async () => {
    let request = null;
    const transport = createInternalArtifactDownloadTransport(
      transportOptions({
        fetchImpl: async (url, init) => {
          request = { url, init };
          return sandboxResponse();
        },
      }),
    );

    await transport.downloadArtifact(input(), {
      traceState: 'vendor=value',
    });

    assert.equal(request.init.headers.tracestate, 'vendor=value');
  });

  it('fails closed when Sandbox response bindings do not match Agent metadata', async () => {
    const cases = [
      { artifactId: '01K0G2PAV8FPMVC9QHJG7JPN60' },
      { sha256: 'f'.repeat(64) },
      { contentLength: BYTES.byteLength + 1 },
    ];
    for (const responseOverrides of cases) {
      const transport = createInternalArtifactDownloadTransport(
        transportOptions({
          fetchImpl: async () => sandboxResponse(responseOverrides),
        }),
      );
      await assert.rejects(
        () => transport.downloadArtifact(input()),
        (error) =>
          error instanceof InternalArtifactDownloadError &&
          error.code === 'SANDBOX_RESPONSE_INVALID',
      );
    }
  });

  it('maps a missing Sandbox snapshot without exposing response metadata', async () => {
    const transport = createInternalArtifactDownloadTransport(
      transportOptions({
        fetchImpl: async () => sandboxResponse({ status: 404 }),
      }),
    );
    await assert.rejects(
      () => transport.downloadArtifact(input()),
      (error) =>
        error instanceof InternalArtifactDownloadError &&
        error.code === 'ARTIFACT_NOT_FOUND' &&
        error.httpStatus === 404 &&
        error.retryable === false,
    );
  });
});
