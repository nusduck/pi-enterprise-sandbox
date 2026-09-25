import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { artifactTypeLabel, dateBucket, formatBytes, isImageArtifact } from '../src/shared/api/artifactLibrary.ts';

describe('artifact library helpers', () => {
  it('labels the file type from the name, then the path, then the MIME subtype', () => {
    assert.equal(artifactTypeLabel({ name: '周报.docx', path: null, mime_type: null }), 'DOCX');
    assert.equal(artifactTypeLabel({ name: '随机 Markdown 文档', path: 'out/a.md', mime_type: 'text/markdown' }), 'MD');
    assert.equal(artifactTypeLabel({ name: 'chart', path: '', mime_type: 'image/png' }), 'PNG');
    assert.equal(artifactTypeLabel({ name: 'x', path: '', mime_type: null }), 'FILE');
  });

  it('groups by local day, week and month', () => {
    const now = new Date(2026, 8, 25, 15, 0);
    assert.equal(dateBucket(new Date(2026, 8, 25, 9, 0).toISOString(), now), '今天');
    assert.equal(dateBucket(new Date(2026, 8, 21, 9, 0).toISOString(), now), '本周');
    assert.equal(dateBucket(new Date(2026, 8, 3, 9, 0).toISOString(), now), '本月');
    assert.equal(dateBucket(new Date(2026, 7, 30, 9, 0).toISOString(), now), '更早');
    assert.equal(dateBucket(null, now), '更早');
  });

  it('formats sizes and detects images', () => {
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(46 * 1024), '46 KB');
    assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB');
    assert.equal(formatBytes(null), '');
    assert.equal(isImageArtifact({ mime_type: 'image/svg+xml' }), true);
    assert.equal(isImageArtifact({ mime_type: 'application/pdf' }), false);
  });
});
