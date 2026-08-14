/**
 * A package that passes lifecycle validation must be a package Pi's own skill
 * loader can read. Two hand-rolled frontmatter parsers used to make that a
 * coincidence rather than a guarantee.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSkillsFromDir } from '@earendil-works/pi-coding-agent';

import {
  SkillFrontmatterError,
  parseSkillFrontmatter,
} from '../src/skills/frontmatter.js';
import { parseSkillMdFrontmatter } from '../src/skills/validator.js';
import { parseSkillMdFrontmatter as parseForAgentCard } from '../src/application/a2a/agent-card.js';

/** @param {string} body */
function skillMd(body) {
  return body;
}

describe('SKILL.md frontmatter reader', () => {
  it('reads plain scalars', () => {
    const out = parseSkillFrontmatter(
      skillMd('---\nname: pdf-report\ndescription: Builds PDF reports\n---\nBody\n'),
      { strict: true },
    );
    assert.equal(out.name, 'pdf-report');
    assert.equal(out.description, 'Builds PDF reports');
    assert.equal(out.body, 'Body');
  });

  it('handles YAML the hand-rolled parser got wrong', () => {
    // Folded scalars and colons inside quoted values are ordinary YAML that a
    // line-regex parser truncates or drops.
    const out = parseSkillFrontmatter(
      skillMd(
        '---\n' +
          'name: sql-review\n' +
          'description: >-\n' +
          '  Reviews SQL migrations:\n' +
          '  locks, indexes, and rollback safety\n' +
          '---\nBody\n',
      ),
      { strict: true },
    );
    assert.equal(out.name, 'sql-review');
    assert.equal(
      out.description,
      'Reviews SQL migrations: locks, indexes, and rollback safety',
    );
  });

  it('accepts CRLF files and a leading BOM', () => {
    const out = parseSkillFrontmatter(
      '﻿---\r\nname: crlf-skill\r\ndescription: Windows authored\r\n---\r\nBody\r\n',
      { strict: true },
    );
    assert.equal(out.name, 'crlf-skill');
    assert.equal(out.description, 'Windows authored');
  });

  it('refuses non-scalar values instead of stringifying them', () => {
    assert.throws(
      () =>
        parseSkillFrontmatter(
          skillMd('---\nname:\n  nested: value\ndescription: d\n---\nBody\n'),
          { strict: true },
        ),
      SkillFrontmatterError,
    );
  });

  it('reports each structural problem specifically in strict mode', () => {
    const cases = [
      ['', /empty or unreadable/],
      ['no frontmatter here', /must start with YAML frontmatter/],
      ['---\nname: a\ndescription: b\n', /not closed/],
      ['---\nname: a\ndescription: b\n---\n', /body is empty/],
      ['---\ndescription: b\n---\nBody\n', /missing required field: name/],
      ['---\nname: a\n---\nBody\n', /missing required field: description/],
      ['---\nname: [unclosed\n---\nBody\n', /not valid YAML/],
    ];
    for (const [content, pattern] of cases) {
      assert.throws(
        () => parseSkillFrontmatter(content, { strict: true }),
        pattern,
        `expected ${pattern} for ${JSON.stringify(content)}`,
      );
    }
  });

  it('degrades to empty fields in non-strict mode', () => {
    for (const content of ['', 'no frontmatter', '---\nname: a\n']) {
      assert.deepEqual(parseSkillFrontmatter(content), {
        name: '',
        description: '',
        body: '',
      });
    }
  });
});

describe('validator and Agent Card agree with Pi loadSkillsFromDir', () => {
  /** @param {string} content */
  function withSkillDir(content, fn) {
    const root = mkdtempSync(join(tmpdir(), 'skill-fm-'));
    try {
      mkdirSync(join(root, 'pkg'));
      writeFileSync(join(root, 'pkg', 'SKILL.md'), content, 'utf8');
      return fn(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('all three readers agree on a folded-scalar description', () => {
    const content =
      '---\n' +
      'name: sql-review\n' +
      'description: >-\n' +
      '  Reviews SQL migrations:\n' +
      '  locks and rollback safety\n' +
      '---\nBody\n';

    const validated = parseSkillMdFrontmatter(content);
    const card = parseForAgentCard(content);
    const loaded = withSkillDir(content, (root) =>
      loadSkillsFromDir({ dir: root, source: 'test' }),
    );

    assert.equal(loaded.skills.length, 1, 'Pi must load the package');
    assert.equal(validated.name, loaded.skills[0].name);
    assert.equal(validated.description, loaded.skills[0].description);
    assert.equal(card.name, loaded.skills[0].name);
    assert.equal(card.description, loaded.skills[0].description);
  });

  it('a package the validator accepts is one Pi can load', () => {
    const content = '---\nname: pdf-report\ndescription: Builds PDFs\n---\nBody\n';
    assert.doesNotThrow(() => parseSkillMdFrontmatter(content));
    const loaded = withSkillDir(content, (root) =>
      loadSkillsFromDir({ dir: root, source: 'test' }),
    );
    assert.deepEqual(
      loaded.skills.map((s) => [s.name, s.description]),
      [['pdf-report', 'Builds PDFs']],
    );
  });
});
