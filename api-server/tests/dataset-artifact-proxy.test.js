/**
 * PR-09 BFF dataset/artifact proxy helpers — streaming spill + ownership headers.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readFile, rm } from 'node:fs/promises';
import {
  mapUploadErrorBody,
  spillRequestToTempFile,
} from '../routes/files.js';
import {
  datasetOwnershipHeaders,
  pipeWithBackpressure,
} from '../routes/datasets.js';

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

describe('spillRequestToTempFile streaming (large multi-chunk)', () => {
  it('spills many chunks without requiring single Buffer of total size', async () => {
    const chunk = Buffer.alloc(64 * 1024, 7);
    const n = 16; // 1 MiB
    const chunks = Array.from({ length: n }, () => chunk);
    const req = Readable.from(chunks);
    const spill = await spillRequestToTempFile(req, 2 * 1024 * 1024);
    try {
      assert.equal(spill.size, n * chunk.length);
      const data = await readFile(spill.filePath);
      assert.equal(data.length, spill.size);
      assert.equal(data[0], 7);
    } finally {
      await rm(spill.dir, { recursive: true, force: true });
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
