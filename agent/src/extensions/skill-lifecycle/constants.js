/**
 * Tool names registered by the skill-lifecycle extension.
 *
 * Kept in its own module so the enterprise-policy risk classifier can import
 * the names without pulling in the extension itself (which depends on typebox
 * and the SkillManager). Every name here must also appear in the risk table;
 * an unclassified tool is denied as UNKNOWN_TOOL_DENIED.
 */
export const SKILL_LIFECYCLE_TOOL_NAMES = Object.freeze([
  'skill_list',
  'skill_install',
  'skill_uninstall',
  'skill_edit',
  'skill_reload',
]);
