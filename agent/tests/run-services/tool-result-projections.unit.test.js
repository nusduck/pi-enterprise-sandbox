import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractSubmittedArtifact } from '../../src/application/tool-result-projections.js';

const SHA = 'a'.repeat(64);
const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

describe('extractSubmittedArtifact', () => {
  it('reads the DSH wrap { value, content, isError } plus snake_case ids', () => {
    const got = extractSubmittedArtifact({
      value: {
        artifact_id: ID,
        name: 'notes.md',
        mime_type: 'text/markdown',
        sha256: SHA,
        size: 12,
      },
      content: [{ type: 'text', text: 'Submitted artifact notes.md (12 bytes).' }],
      isError: false,
    });
    assert.deepEqual(got, {
      artifactId: ID,
      name: 'notes.md',
      mimeType: 'text/markdown',
      size: 12,
      sha256: SHA,
      description: null,
    });
  });

  it('defaults mimeType when the tool omitted it', () => {
    const got = extractSubmittedArtifact({
      details: {
        artifactId: ID,
        displayName: 'notes.md',
        sha256: SHA,
        size: 12,
      },
    });
    assert.equal(got.mimeType, 'application/octet-stream');
  });

  it('rejects a non-ULID exec art_ uuid so A2A never sees a synthetic id', () => {
    assert.equal(
      extractSubmittedArtifact({
        artifactId: 'art_0123456789abcdef0123456789abcdef',
        name: 'notes.md',
        sha256: SHA,
        size: 12,
      }),
      null,
    );
  });
});
