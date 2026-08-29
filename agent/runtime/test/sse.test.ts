/**
 * SSE 契约：夹具 sample_stream 逐字节不变；required_event_types 都有形状。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { encodeSseStream, projectToSse, type SseEvent } from '../src/projection/sse.js';

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../tests/fixtures/sse_events.json',
);

interface Fixture {
  required_event_types: string[];
  event_shapes: Record<string, { type: string }>;
  sample_stream: SseEvent[];
}

test('sample_stream JSON 与夹具逐字节一致', () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture;
  const projected = fixture.sample_stream.map((ev) => projectToSse({ kind: ev.type, payload: ev }));
  assert.equal(projected.every((e) => e !== null), true);
  assert.equal(JSON.stringify(projected), JSON.stringify(fixture.sample_stream));
});

test('sample_stream SSE 编码稳定', () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture;
  const expected = fixture.sample_stream.map((ev) => `data: ${JSON.stringify(ev)}\n\n`).join('');
  assert.equal(encodeSseStream(fixture.sample_stream), expected);
});

test('required_event_types 都在 event_shapes 里且 type 字段对齐', () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture;
  for (const t of fixture.required_event_types) {
    assert.equal(fixture.event_shapes[t]?.type, t, t);
  }
});
