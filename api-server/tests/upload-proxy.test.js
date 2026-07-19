/**
 * Upload proxy helpers — error mapping and temp spill size gate.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  mapUploadErrorBody,
  resolveUploadTraceId,
  discardRequestBody,
  spillRequestToTempFile,
} from '../src/routes/files.js';
import { readFile, rm } from 'node:fs/promises';

describe('mapUploadErrorBody', () => {
  it('preserves structured sandbox detail codes', () => {
    const out = mapUploadErrorBody(413, {
      detail: { code: 'attachment_too_large', message: 'too big' },
    }, 'trace-abc');
    assert.equal(out.code, 'attachment_too_large');
    assert.equal(out.error, 'too big');
    assert.equal(out.trace_id, 'trace-abc');
  });

  it('maps bare 413 without body', () => {
    const out = mapUploadErrorBody(413, null, 't1');
    assert.equal(out.code, 'attachment_too_large');
    assert.equal(out.trace_id, 't1');
  });

  it('passes through string detail', () => {
    const out = mapUploadErrorBody(400, { detail: 'nope' });
    assert.equal(out.error, 'nope');
  });
});

describe('resolveUploadTraceId / discardRequestBody', () => {
  it('prefers inbound X-Trace-Id header', () => {
    const id = resolveUploadTraceId({ headers: { 'x-trace-id': 'from-browser' } });
    assert.equal(id, 'from-browser');
  });

  it('generates a fallback when header missing', () => {
    const id = resolveUploadTraceId({ headers: {} });
    assert.equal(typeof id, 'string');
    assert.ok(id.length > 8);
  });

  it('discardRequestBody is safe on null and destroyable streams', () => {
    discardRequestBody(null);
    let destroyed = false;
    discardRequestBody({
      resume() {},
      destroy() { destroyed = true; },
    });
    assert.equal(destroyed, true);
  });
});

describe('spillRequestToTempFile', () => {
  it('streams body to temp file without requiring full buffer', async () => {
    const payload = Buffer.from('hello-stream-body');
    // Minimal fake IncomingMessage-like readable
    const req = Readable.from([payload]);
    // spill expects .on/.off/.pause/.resume — Readable has them
    const spill = await spillRequestToTempFile(req, 1024 * 1024);
    try {
      const data = await readFile(spill.filePath);
      assert.equal(data.toString(), 'hello-stream-body');
      assert.equal(spill.size, payload.length);
    } finally {
      await rm(spill.dir, { recursive: true, force: true });
    }
  });

  it('rejects when body exceeds maxBytes with 413 code', async () => {
    const chunks = [Buffer.alloc(100, 1), Buffer.alloc(100, 2)];
    const req = Readable.from(chunks);
    await assert.rejects(
      () => spillRequestToTempFile(req, 150),
      (err) => {
        assert.equal(err.status, 413);
        assert.equal(err.code, 'attachment_too_large');
        return true;
      },
    );
  });
});
