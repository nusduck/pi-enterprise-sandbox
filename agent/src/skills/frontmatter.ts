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
 * So the parse is real YAML via the same `yaml` library, with the same
 * delimiter rule, that Pi's `parseFrontmatter` uses; this module only adds what
 * Pi has no opinion about: the enterprise field bounds and the error messages
 * an operator installing a package needs to read.
 *
 * Why `yaml` directly and not `parseFrontmatter` from the SDK: this module is
 * reached from the A2A Agent Card handler, and a static SDK import there costs
 * ~300ms of process start and pulls the whole coding agent into an HTTP process
 * that never runs one — before `assertSdkVersionPinned` has had a chance to
 * check the version. `tests/skills-frontmatter.test.js` asserts agreement with
 * `loadSkillsFromDir` on real packages, which is the property that actually
 * matters and the one a shared import only implies.
 */

import { parse as parseYaml } from 'yaml';

/**
 * Frontmatter extraction, matching Pi's `parseFrontmatter` exactly: a leading
 * `---`, the next `\n---`, and everything between them as YAML.
 *
 * @param normalized  content with CRLF already normalised
 * @returns {{ yamlString: string | null, body: string }}
 */
function extractFrontmatter(normalized: string) {
  if (!normalized.startsWith('---')) {
    return { yamlString: null, body: normalized };
  }
  const endIndex = normalized.indexOf('\n---', 3);
  if (endIndex === -1) {
    return { yamlString: null, body: normalized };
  }
  return {
    yamlString: normalized.slice(4, endIndex),
    body: normalized.slice(endIndex + 4).trim(),
  };
}

/**
 * @param content
 * @returns {{ frontmatter: Record<string, unknown>, body: string }}
 */
function parseFrontmatter(content: string) {
  const { yamlString, body } = extractFrontmatter(content.replace(/\r\n/g, '\n'));
  if (!yamlString) return { frontmatter: {}, body };
  return { frontmatter: parseYaml(yamlString) ?? {}, body };
}

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
 * @param value
 * @returns {string}
 */
function scalarString(value: unknown) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

/**
 * Turn a YAML parse failure into something an operator can act on.
 *
 * This parser is stricter than the regex it replaced, which is the point —
 * agreeing with Pi's loader is what stops a package installing and then failing
 * to load. But it means SKILL.md files that used to install can now be
 * rejected, and the two common cases are both easy to fix once you can see the
 * line: an unquoted colon (`description: Use this when: ...`) and a leading
 * reserved character (`description: @mention ...`). A bare parser message with
 * no line does not get an operator there.
 *
 * @param err
 * @param text
 * @returns {string}
 */
function describeYamlError(err: unknown, text: string) {
  const detail = err instanceof Error ? err.message : String(err);
  // `yaml` reports linePos against the frontmatter block it was handed, not
  // the file, so resolve the offending line against the same slice the SDK
  // parses (everything between the two `---` markers).
  const normalized = text.replace(/\r\n/g, '\n');
  const blockEnd = normalized.indexOf('\n---', 3);
  const block = blockEnd === -1 ? '' : normalized.slice(4, blockEnd);
  const blockLine =
    (err as any)?.linePos?.[0]?.line ??
    (err as any)?.linePos?.line ??
    null;
  const source =
    typeof blockLine === 'number' ? block.split('\n')[blockLine - 1] : null;

  let hint = '';
  if (source) {
    const value = source.replace(/^\s*[A-Za-z0-9_-]+\s*:\s*/, '');
    if (value !== source && /:\s/.test(value)) {
      hint =
        ' A value containing ": " must be quoted, e.g. description: "Use this when: ...".';
    } else if (value !== source && /^[@`|>%&*!]/.test(value)) {
      hint = ' A value starting with a YAML reserved character must be quoted.';
    }
  }

  // The parser echoes the offending line with a caret already; keep the
  // resolved file line only when it adds something.
  const location =
    source && !detail.includes(source.trim())
      ? ` (frontmatter line ${blockLine}: ${source.trim().slice(0, 120)})`
      : '';
  return `SKILL.md frontmatter is not valid YAML: ${detail}${location}${hint}`;
}

/**
 * Read `name` / `description` from SKILL.md frontmatter.
 *
 * @param content
 * @param [opts]
 *   `strict` (lifecycle install/validate) throws a specific SkillFrontmatterError
 *   on anything unusable. Non-strict (Agent Card listing) returns empty fields so
 *   a malformed package degrades to its directory name instead of breaking the
 *   whole card.
 * @returns {{ name: string, description: string, body: string }}
 */
export function parseSkillFrontmatter(content: unknown, opts: { strict?: boolean } = {}) {
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
    return fail(describeYamlError(err, text));
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
