/**
 * One SKILL.md frontmatter reader for the whole service.
 *
 * There were two hand-rolled parsers — the lifecycle validator's and the A2A
 * Agent Card's — each accepting a slightly different subset of YAML, and
 * neither matching the SDK's `loadSkillsFromDir`, which is what actually
 * decides whether the model ever sees a skill. That gap is installable-but-
 * invisible skills: a package passes lifecycle validation, then the runtime
 * loader reads its frontmatter differently and drops it.
 *
 * So the parse is delegated to the SDK's `parseFrontmatter` (real YAML, same
 * function the loader uses) and this module only adds what the SDK has no
 * opinion about: the enterprise field bounds and the error messages an operator
 * installing a package needs to read.
 */

import { parseFrontmatter } from '@earendil-works/pi-coding-agent';

/** Bounds mirror the Agent Card / catalog columns these values land in. */
export const MAX_SKILL_NAME_CHARS = 256;
export const MAX_SKILL_DESCRIPTION_CHARS = 1024;

export class SkillFrontmatterError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'SkillFrontmatterError';
  }
}

/**
 * Scalar-only coercion. A YAML parser happily returns objects, arrays, numbers
 * and dates; `name`/`description` are strings, and quietly stringifying a map
 * into "[object Object]" is worse than reporting nothing.
 *
 * @param {unknown} value
 * @returns {string}
 */
function scalarString(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

/**
 * Read `name` / `description` from SKILL.md frontmatter.
 *
 * @param {unknown} content
 * @param {{ strict?: boolean }} [opts]
 *   `strict` (lifecycle install/validate) throws a specific SkillFrontmatterError
 *   on anything unusable. Non-strict (Agent Card listing) returns empty fields so
 *   a malformed package degrades to its directory name instead of breaking the
 *   whole card.
 * @returns {{ name: string, description: string, body: string }}
 */
export function parseSkillFrontmatter(content, opts = {}) {
  const strict = opts.strict === true;
  /** @param {string} message */
  const fail = (message) => {
    if (strict) throw new SkillFrontmatterError(message);
    return { name: '', description: '', body: '' };
  };

  if (typeof content !== 'string' || content === '') {
    return fail('SKILL.md is empty or unreadable');
  }

  // The SDK matches on a leading `---`, so a BOM would make it treat a
  // perfectly good file as having no frontmatter at all.
  const text = content.replace(/^﻿/, '');
  if (!text.replace(/\r\n/g, '\n').startsWith('---')) {
    return fail('SKILL.md must start with YAML frontmatter (---)');
  }
  if (text.replace(/\r\n/g, '\n').indexOf('\n---', 3) === -1) {
    return fail('SKILL.md frontmatter is not closed');
  }

  /** @type {{ frontmatter: Record<string, unknown>, body: string }} */
  let parsed;
  try {
    parsed = parseFrontmatter(text);
  } catch (err) {
    return fail(
      `SKILL.md frontmatter is not valid YAML: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const name = scalarString(parsed.frontmatter?.name).slice(
    0,
    MAX_SKILL_NAME_CHARS,
  );
  const description = scalarString(parsed.frontmatter?.description).slice(
    0,
    MAX_SKILL_DESCRIPTION_CHARS,
  );
  const body = typeof parsed.body === 'string' ? parsed.body : '';

  if (strict) {
    if (!body.trim()) {
      return fail('SKILL.md body is empty after frontmatter');
    }
    if (!name) {
      return fail('SKILL.md frontmatter missing required field: name');
    }
    if (!description) {
      return fail('SKILL.md frontmatter missing required field: description');
    }
  }

  return { name, description, body };
}
