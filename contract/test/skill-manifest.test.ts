/**
 * `skill-manifest.ts`：清单校验、GET 规范化签名字节、版本目录路径与侧车解析。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ContractError } from '../src/errors.js';
import {
  ENABLED_SKILLS_MAX,
  assertNoDuplicateSkillScopes,
  canonicalQueryBytes,
  parseEnabledSkills,
  parseSkillVersionSidecar,
  parseSystemSkills,
  skillVersionPaths,
  SYSTEM_SKILLS_MAX,
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

describe('parseEnabledSkills：scope（ADR 0015 D5）', () => {
  it('省略 scope = user，且不写进结果（旧 Agent 语义不变）', () => {
    assert.deepEqual(parseEnabledSkills([{ name: 'a', contentDigest: DIGEST }]), [
      { name: 'a', contentDigest: DIGEST },
    ]);
  });

  it('scope: org 被保留，用于选 owner 根', () => {
    assert.deepEqual(parseEnabledSkills([{ name: 'a', contentDigest: DIGEST, scope: 'org' }]), [
      { name: 'a', contentDigest: DIGEST, scope: 'org' },
    ]);
  });

  it('未知 scope 是错误，不静默当作 user', () => {
    rejects([{ name: 'a', contentDigest: DIGEST, scope: 'system' }], /scope/);
  });
});

describe('parseSystemSkills（ADR 0015 D4 / design §6.3、§8）', () => {
  it('缺失返回 null（滚动升级兼容期：旧 Agent 不发名单，exec 维持整树挂载）', () => {
    // design §8：部署顺序 exec → Worker。exec 先升级时旧 Worker 还不会发名单，
    // 缺省若直接拒绝，旧 Worker 的每个 Run 都会失败。`null` 与 `[]` 必须可区分。
    for (const missing of [undefined, null]) {
      assert.equal(parseSystemSkills(missing), null);
    }
  });

  it('空数组是合法值：「一个系统包都不带」', () => {
    assert.deepEqual(parseSystemSkills([]), []);
  });

  it('接受合法名字数组并保持顺序', () => {
    assert.deepEqual(parseSystemSkills(['pdf', 'xlsx']), ['pdf', 'xlsx']);
  });

  it('拒绝非法名、重复名、非数组与超限', () => {
    assert.throws(() => parseSystemSkills(['PDF']), /systemSkills/);
    assert.throws(() => parseSystemSkills(['pdf', 'pdf']), /repeat/);
    assert.throws(() => parseSystemSkills('pdf'), /array/);
    assert.throws(
      () => parseSystemSkills(Array.from({ length: SYSTEM_SKILLS_MAX + 1 }, (_, i) => `s${i}`)),
      /exceed/,
    );
  });
});

describe('assertNoDuplicateSkillScopes', () => {
  it('同一个名字同时出现在两层 → ENVELOPE_INVALID', () => {
    assert.throws(
      () => assertNoDuplicateSkillScopes(['pdf'], [{ name: 'pdf', contentDigest: DIGEST }]),
      (err: unknown) => err instanceof ContractError && err.code === 'ENVELOPE_INVALID',
    );
  });

  it('空系统清单、缺省清单与不重叠的清单都不报错', () => {
    assert.doesNotThrow(() => assertNoDuplicateSkillScopes([], [{ name: 'pdf', contentDigest: DIGEST }]));
    assert.doesNotThrow(() => assertNoDuplicateSkillScopes(null, [{ name: 'pdf', contentDigest: DIGEST }]));
    assert.doesNotThrow(() => assertNoDuplicateSkillScopes(['xlsx'], [{ name: 'pdf', contentDigest: DIGEST }]));
  });
});
