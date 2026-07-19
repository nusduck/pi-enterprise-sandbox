import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeToolRequestHashV1 } from '../../src/domain/tool/tool-request-hash.js';
import { createInternalFilesWriteTransport } from '../../src/infrastructure/sandbox/internal-files-write-http.js';

const identity = Object.freeze({
  orgId: '01K0G2PAV8FPMVC9QHJG7JPN4Z',
  userId: '01K0G2PAV8FPMVC9QHJG7JPN50',
  conversationId: '01K0G2PAV8FPMVC9QHJG7JPN51',
  agentSessionId: '01K0G2PAV8FPMVC9QHJG7JPN52',
  runId: '01K0G2PAV8FPMVC9QHJG7JPN53',
  sandboxSessionId: '01K0G2PAV8FPMVC9QHJG7JPN54',
  traceId: '0123456789abcdef0123456789abcdef',
  executionFenceToken: 7,
});
const TE = '01K0G2PAV8FPMVC9QHJG7JPN70';
function payload(tool, args) { const h = computeToolRequestHashV1({ toolName:tool, args }); return { ...args, identity, toolExecutionId:TE, toolCallId:`tc-${tool}`, requestHash:h.requestHash, requestHashVersion:1 }; }
function tokenFor(meta) { return `x.${Buffer.from(JSON.stringify({ jti: meta.expectedJti })).toString('base64url')}.x`; }
const tokenForIssuer = async (_claims, meta) => tokenFor(meta);

describe('createInternalFilesWriteTransport', () => {
  it('binds exact write body and HMAC claims, filtering response', async () => {
    let seen;
    const args = { path:'/home/sandbox/workspace/a.txt', content:'hello', encoding:'utf-8' };
    const transport = createInternalFilesWriteTransport({
      baseUrl:'http://sandbox:8081',
      allowInsecureHttp: true,
      tokenIssuer: async (claims, meta) => { seen = { claims, body:JSON.parse(meta.bodyBytes.toString('utf8')) }; return tokenFor(meta); },
      fetchImpl: async (_url, init) => { seen.headers = init.headers; return { ok:true, status:200, json:async () => ({ path:args.path, size:5, hash:'a'.repeat(64), version:'a'.repeat(64), physicalPath:'/secret' }) }; },
    });
    const out = await transport.writeFile(payload('write', args));
    assert.equal(seen.claims.scope[0], 'sandbox.files.write');
    assert.equal(seen.claims.htu, '/internal/v1/files/write');
    assert.deepEqual(seen.body.content, 'hello');
    assert.equal(seen.headers['X-Trace-Id'], identity.traceId);
    assert.match(seen.headers.traceparent, new RegExp(`^00-${identity.traceId}-[0-9a-f]{16}-01$`));
    assert.equal(out.physicalPath, undefined);
  });

  it('requires edit precondition and rejects request hash tampering before fetch', async () => {
    let calls = 0;
    const transport = createInternalFilesWriteTransport({ baseUrl:'http://sandbox:8081', allowInsecureHttp:true, tokenIssuer:tokenForIssuer, fetchImpl:async()=>{ calls++; } });
    const args = { path:'/home/sandbox/workspace/a.txt', oldText:'a', newText:'b', expectedHash:'a'.repeat(64) };
    await assert.rejects(() => transport.editFile({ ...payload('edit', args), requestHash:'b'.repeat(64) }), { code:'FILES_WRITE_HASH' });
    await assert.rejects(() => transport.editFile(payload('edit', { path:args.path, oldText:'a', newText:'b' })), { code:'FILE_VERSION_PRECONDITION_REQUIRED' });
    assert.equal(calls, 0);
  });

  it('marks ambiguous post-dispatch network failure as outcome unknown', async () => {
    const args = { path:'/home/sandbox/workspace/a.txt', content:'x', encoding:'utf-8' };
    const transport = createInternalFilesWriteTransport({ baseUrl:'http://sandbox:8081', allowInsecureHttp:true, tokenIssuer:tokenForIssuer, fetchImpl:async()=>{ throw new Error('reset'); } });
    await assert.rejects(() => transport.writeFile(payload('write', args)), (err) => err.code === 'TOOL_OUTCOME_UNKNOWN' && err.outcomeUnknown === true);
  });

  it('rejects noncanonical base64 and edit aliases before fetch', async () => {
    let calls = 0;
    const transport = createInternalFilesWriteTransport({
      baseUrl: 'http://sandbox:8081',
      allowInsecureHttp: true,
      tokenIssuer: tokenForIssuer,
      fetchImpl: async () => { calls += 1; },
    });
    const badBase64 = { path:'/home/sandbox/workspace/a.bin', content:'***', encoding:'base64' };
    await assert.rejects(
      () => transport.writeFile(payload('write', badBase64)),
      { code: 'FILES_WRITE_PAYLOAD_INVALID' },
    );
    const aliasArgs = {
      path: '/home/sandbox/workspace/a.txt',
      oldString: 'a',
      newString: 'b',
      expectedHash: 'a'.repeat(64),
    };
    await assert.rejects(
      () => transport.editFile(payload('edit', aliasArgs)),
      { code: 'FILES_WRITE_PAYLOAD_INVALID' },
    );
    assert.equal(calls, 0);
  });

  it('rejects a token issuer that ignores the transport jti', async () => {
    const args = { path:'/home/sandbox/workspace/a.txt', content:'x', encoding:'utf-8' };
    const transport = createInternalFilesWriteTransport({
      baseUrl: 'http://sandbox:8081',
      allowInsecureHttp: true,
      tokenIssuer: async () => tokenFor({ expectedJti: 'wrong' }),
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    });
    await assert.rejects(
      () => transport.writeFile(payload('write', args)),
      { code: 'SANDBOX_TOKEN_JTI_MISMATCH' },
    );
  });
});
