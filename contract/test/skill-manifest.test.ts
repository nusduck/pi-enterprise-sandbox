/**
 * `skill-manifest.ts`：清单校验、GET 规范化签名字节、版本目录路径与侧车解析。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ContractError } from '../src/errors.js';
import {
  ENABLED_SKILLS_MAX,
  canonicalQueryBytes,
  parseEnabledSkills,
  parseSkillVersionSidecar,
  skillVersionPaths,
} from '../src/skill-manifest.js';

const DIGEST = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

function rejects(value: unknown, pattern: RegExp): void {
  assert.throws(
    () => parseEnabledSkills(value),
    (err: unknown) => err instanceof ContractError && err.code === 'ENVELOPE_INVALID' && pattern.test(err.message),
  );
}

describe('parseEnabledSkills', () => {
  it('treats a missing manifest as empty', () => {
    assert.deepEqual(parseEnabledSkills(undefined), []);
    assert.deepEqual(parseEnabledSkills(null), []);
  });

  it('accepts well-formed entries and keeps only name and digest', () => {
    const parsed = parseEnabledSkills([
      { name: 'docx-helper', contentDigest: DIGEST, extra: 'ignored' },
      { name: 'b', contentDigest: OTHER },
    ]);
    assert.deepEqual(parsed, [
      { name: 'docx-helper', contentDigest: DIGEST },
      { name: 'b', contentDigest: OTHER },
    ]);
  });

  it('rejects malformed manifests instead of skipping entries', () => {
    rejects('nope', /must be an array/);
    rejects([null], /must be objects/);
    rejects([{ name: '../etc', contentDigest: DIGEST }], /name is invalid/);
    rejects([{ name: '.v', contentDigest: DIGEST }], /name is invalid/);
    rejects([{ name: 'ok', contentDigest: 'A'.repeat(64) }], /sha256 hex/);
    rejects([{ name: 'ok', contentDigest: DIGEST.slice(1) }], /sha256 hex/);
    rejects(
      [
        { name: 'dup', contentDigest: DIGEST },
        { name: 'dup', contentDigest: OTHER },
      ],
      /repeat a name/,
    );
    rejects(
      Array.from({ length: ENABLED_SKILLS_MAX + 1 }, (_, i) => ({ name: `s${i}`, contentDigest: DIGEST })),
      /must not exceed/,
    );
  });
});

describe('canonicalQueryBytes', () => {
  it('does not depend on parameter order', () => {
    const a = canonicalQueryBytes({ target: 't', envelope: 'e', enabledSkills: 's' });
    const b = canonicalQueryBytes({ enabledSkills: 's', envelope: 'e', target: 't' });
    assert.deepEqual(a, b);
    assert.equal(new TextDecoder().decode(a), 'enabledSkills=s&envelope=e&target=t');
  });

  it('changes when any value changes, including an added parameter', () => {
    const base = canonicalQueryBytes({ envelope: 'e', target: 't' });
    assert.notDeepEqual(canonicalQueryBytes({ envelope: 'e', target: 'u' }), base);
    assert.notDeepEqual(canonicalQueryBytes({ envelope: 'e', target: 't', enabledSkills: 's' }), base);
  });

  it('encodes separators so a value cannot forge another pair', () => {
    const forged = canonicalQueryBytes({ envelope: 'e&target=x' });
    const honest = canonicalQueryBytes({ envelope: 'e', target: 'x' });
    assert.notDeepEqual(forged, honest);
  });
});

describe('skillVersionPaths', () => {
  it('nests the package under its version root', () => {
    assert.deepEqual(skillVersionPaths('/base/org/user/', 'demo', DIGEST), {
      versionRoot: `/base/org/user/demo/.v/${DIGEST}`,
      packageDir: `/base/org/user/demo/.v/${DIGEST}/demo`,
      sidecar: `/base/org/user/demo/.v/${DIGEST}.json`,
    });
  });

  it('refuses names or digests that could escape the owner root', () => {
    assert.throws(() => skillVersionPaths('/base', '../x', DIGEST), ContractError);
    assert.throws(() => skillVersionPaths('/base', 'demo', '../../etc'), ContractError);
  });
});

describe('parseSkillVersionSidecar', () => {
  const good = {
    name: 'demo',
    contentDigest: DIGEST,
    fileCount: 2,
    totalBytes: 318,
    publishedAt: '2026-09-14T12:00:00.000Z',
  };

  it('parses a complete sidecar', () => {
    assert.deepEqual(parseSkillVersionSidecar(JSON.stringify(good)), good);
  });

  it('returns null for anything incomplete or malformed', () => {
    assert.equal(parseSkillVersionSidecar('{'), null);
    assert.equal(parseSkillVersionSidecar('[]'), null);
    assert.equal(parseSkillVersionSidecar(JSON.stringify({ ...good, contentDigest: 'x' })), null);
    assert.equal(parseSkillVersionSidecar(JSON.stringify({ ...good, fileCount: -1 })), null);
    assert.equal(parseSkillVersionSidecar(JSON.stringify({ ...good, publishedAt: 'never' })), null);
  });
});
