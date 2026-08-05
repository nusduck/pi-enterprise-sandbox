/** SKILL.md and installed-package validators. */
import fs from 'node:fs';
import path from 'node:path';
import { validateSkillName } from './paths.js';

/**
 * Parse the required name and description from SKILL.md frontmatter.
 * This intentionally stays small: full YAML interpretation belongs to the
 * runtime loader, while lifecycle validation only needs these two scalars.
 *
 * @param {string} content
 * @returns {{ name: string, description: string, rawFrontmatter: string }}
 */
export function parseSkillMdFrontmatter(content) {
  if (content == null || typeof content !== 'string') {
    throw new Error('SKILL.md is empty or unreadable');
  }
  const text = content.replace(/^\uFEFF/, '');
  if (!text.startsWith('---')) {
    throw new Error('SKILL.md must start with YAML frontmatter (---)');
  }
  const end = text.indexOf('\n---', 3);
  if (end === -1) throw new Error('SKILL.md frontmatter is not closed');
  const frontmatter = text.slice(3, end).trim();
  const body = text.slice(end + 4);
  if (!body.trim()) throw new Error('SKILL.md body is empty after frontmatter');

  /** @type {Record<string, string>} */
  const fields = {};
  for (const line of frontmatter.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      try {
        value = JSON.parse(value);
      } catch {
        value = value.slice(1, -1);
      }
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    fields[match[1]] = value;
  }

  if (!fields.name || !String(fields.name).trim()) {
    throw new Error('SKILL.md frontmatter missing required field: name');
  }
  if (!fields.description || !String(fields.description).trim()) {
    throw new Error('SKILL.md frontmatter missing required field: description');
  }
  return {
    name: validateSkillName(fields.name),
    description: String(fields.description).trim(),
    rawFrontmatter: frontmatter,
  };
}

/**
 * Validate a package directory and its SKILL.md.
 * @param {string} dir
 * @param {{ expectedName?: string }} [opts]
 */
export function validateSkillPackage(dir, opts = {}) {
  if (!dir || typeof dir !== 'string') {
    throw new Error('Skill package directory is required');
  }
  const absolute = path.resolve(dir);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) {
    throw new Error(`Skill package not found or not a directory: ${path.basename(absolute)}`);
  }
  const skillMdPath = path.join(absolute, 'SKILL.md');
  if (!fs.existsSync(skillMdPath) || !fs.statSync(skillMdPath).isFile()) {
    throw new Error('Missing SKILL.md in Skill package');
  }
  const metadata = parseSkillMdFrontmatter(fs.readFileSync(skillMdPath, 'utf8'));
  if (opts.expectedName) {
    const expected = validateSkillName(opts.expectedName);
    if (metadata.name !== expected) {
      throw new Error(
        `SKILL.md name "${metadata.name}" does not match package name "${expected}"`,
      );
    }
  }
  return {
    name: metadata.name,
    description: metadata.description,
    skillMdPath,
  };
}
