/** SKILL.md and installed-package validators. */
import fs from 'node:fs';
import path from 'node:path';
import { validateSkillName } from './paths.js';
import { parseSkillFrontmatter } from './frontmatter.js';

/**
 * Parse the required name and description from SKILL.md frontmatter.
 *
 * Delegates the YAML to the same parser Pi's skill loader uses, so a package
 * that installs is a package the runtime can actually load. Only the enterprise
 * name policy is applied on top.
 *
 * @param {string} content
 * @returns {{ name: string, description: string }}
 */
export function parseSkillMdFrontmatter(content) {
  const { name, description } = parseSkillFrontmatter(content, { strict: true });
  return {
    name: validateSkillName(name),
    description,
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
