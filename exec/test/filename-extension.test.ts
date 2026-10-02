/**
 * `extensionOf` 合并后的行为钉住测试（F16）。
 *
 * `attachment/sanitize.ts` 是唯一实现，`dataset/service.ts` 复用它。
 * 复合后缀集合与点文件口径以 dataset 版为准，并纳入 `.tar.zst`。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extensionOf, isAllowedExtension } from '../src/attachment/sanitize.js';
import { sanitizeDatasetFilename } from '../src/dataset/service.js';

describe('extensionOf (canonical)', () => {
  it('keeps compound suffixes as a unit, case-insensitively', () => {
    assert.equal(extensionOf('a.tar.gz'), '.tar.gz');
    assert.equal(extensionOf('A.TAR.BZ2'), '.tar.bz2');
    assert.equal(extensionOf('a.tar.xz'), '.tar.xz');
    assert.equal(extensionOf('a.tar.zst'), '.tar.zst');
    assert.equal(extensionOf('A.TAR.ZST'), '.tar.zst');
  });

  it('returns the last simple suffix lowercased', () => {
    assert.equal(extensionOf('foo.txt'), '.txt');
    assert.equal(extensionOf('FOO.TXT'), '.txt');
    assert.equal(extensionOf('  spaced.csv  '), '.csv');
  });

  it('treats leading-dot filenames as having no extension', () => {
    assert.equal(extensionOf('.bashrc'), '');
    assert.equal(extensionOf('.profile'), '');
    assert.equal(extensionOf('noext'), '');
    assert.equal(extensionOf(''), '');
  });

  it('keeps the historical edge outputs', () => {
    // 全名就是复合后缀：仍整体返回；末尾孤点：返回 '.'（两版旧实现一致）。
    assert.equal(extensionOf('.tar.gz'), '.tar.gz');
    assert.equal(extensionOf('archive.'), '.');
  });
});

describe('merge does not widen upload allowlists', () => {
  it('isAllowedExtension still rejects non-allowlisted suffixes', () => {
    assert.equal(isAllowedExtension('a.txt'), true);
    assert.equal(isAllowedExtension('.bashrc'), false);
    // `.tar.zst` 纳入的是扩展名解析（截断不断错），不是上传白名单。
    assert.equal(isAllowedExtension('a.tar.zst'), false);
  });

  it('dataset truncation keeps the compound suffix as a unit', () => {
    const long = `${'a'.repeat(200)}.tar.zst`;
    const safe = sanitizeDatasetFilename(long);
    assert.ok(safe.length <= 200);
    assert.ok(safe.endsWith('.tar.zst'));
  });
});
