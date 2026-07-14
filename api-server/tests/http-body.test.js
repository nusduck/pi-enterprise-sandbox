import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readJsonBody } from '../http/body.js';

function request(chunks, headers = {}) {
  const stream = Readable.from(chunks);
  stream.headers = headers;
  return stream;
}

describe('bounded JSON body parser', () => {
  it('parses a JSON object and treats an empty body as an object', async () => {
    assert.deepEqual(await readJsonBody(request(['{"ok":true}'])), { ok: true });
    assert.deepEqual(await readJsonBody(request([])), {});
  });

  it('returns a controlled 400 for invalid JSON', async () => {
    await assert.rejects(
      readJsonBody(request(['{"broken"'])),
      (error) => error?.status === 400 && error?.code === 'INVALID_JSON',
    );
  });

  it('rejects declared and streamed bodies over the configured limit', async () => {
    await assert.rejects(
      readJsonBody(request([], { 'content-length': '20' }), { maxBytes: 10 }),
      (error) => error?.status === 413 && error?.code === 'BODY_TOO_LARGE',
    );
    await assert.rejects(
      readJsonBody(request(['12345', '67890', 'x']), { maxBytes: 10 }),
      (error) => error?.status === 413 && error?.code === 'BODY_TOO_LARGE',
    );
  });
});
