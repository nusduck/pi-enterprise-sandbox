/**
 * Golden: SDK session events → BFF SSE types (shared fixture alignment).
 * Run: node --test api-server/tests/sdk-compat/sse-event-map.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mapSdkEventToSse,
  extractToolDetails,
  BFF_LIFECYCLE_SSE_TYPES,
  SDK_MAPPED_SSE_TYPES,
} from '../../services/sdk-sse-map.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/sdk-to-sse-golden.json'), 'utf8'),
);
const sharedSse = JSON.parse(
  readFileSync(join(__dirname, '../../../tests/fixtures/sse_events.json'), 'utf8'),
);

describe('mapSdkEventToSse golden vectors', () => {
  for (const c of golden.cases) {
    it(c.name, () => {
      const pendingToolArgs = new Map();
      const actual = [];
      for (const ev of c.sdk_events) {
        actual.push(...mapSdkEventToSse(ev, { pendingToolArgs }));
      }
      assert.deepEqual(actual, c.expected_sse);
    });
  }
});

describe('SSE type contract alignment', () => {
  it('mapped SDK SSE types are in shared required_event_types', () => {
    const required = new Set(sharedSse.required_event_types);
    for (const t of SDK_MAPPED_SSE_TYPES) {
      assert.ok(required.has(t), `missing shared type ${t}`);
    }
    for (const t of golden.required_bff_sse_types_from_sdk) {
      assert.ok(required.has(t), `golden sdk type ${t} not in shared fixture`);
    }
  });

  it('lifecycle SSE types are in shared required_event_types', () => {
    const required = new Set(sharedSse.required_event_types);
    for (const t of BFF_LIFECYCLE_SSE_TYPES) {
      assert.ok(required.has(t), `missing lifecycle type ${t}`);
    }
    for (const t of golden.required_lifecycle_sse_types) {
      assert.ok(required.has(t), `golden lifecycle ${t} not in shared fixture`);
    }
  });

  it('sample_stream only uses declared types', () => {
    const allowed = new Set(sharedSse.required_event_types);
    for (const ev of sharedSse.sample_stream) {
      assert.ok(allowed.has(ev.type), `sample stream undeclared type ${ev.type}`);
    }
  });
});

describe('extractToolDetails', () => {
  it('parses artifact fields from text', () => {
    const d = extractToolDetails(
      'Artifact submitted: note.txt (artifact_id=art_9, path=note.txt, size=12)',
    );
    assert.equal(d.artifact_id, 'art_9');
    assert.equal(d.path, 'note.txt');
    assert.equal(d.size, 12);
  });

  it('prefers details object', () => {
    const d = extractToolDetails({
      details: { artifact_id: 'a', path: 'p', name: 'n', mime_type: 'text/plain', size: 3 },
      content: [{ type: 'text', text: 'ignore' }],
    });
    assert.equal(d.artifact_id, 'a');
    assert.equal(d.mime_type, 'text/plain');
  });
});
