import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const PACKAGE_SKILL_PATH = join(PACKAGE_ROOT, 'skills');
export const PACKAGE_PROMPT_PATH = join(PACKAGE_ROOT, 'prompts');

export function createDynamicResourcesExtension(options = {}) {
  const packageSkillPath = PACKAGE_SKILL_PATH;
  const packagePromptPath = PACKAGE_PROMPT_PATH;
  const extraSkillPaths = (options.extraSkillPaths || []).filter(Boolean);
  const extraPromptPaths = (options.extraPromptPaths || []).filter(Boolean);

  return function dynamicResourcesExtension(pi) {
    pi.on('resources_discover', (event) => {
      const result = {
        skillPaths: [packageSkillPath, ...extraSkillPaths],
        promptPaths: [packagePromptPath, ...extraPromptPaths],
      };
      options.emit?.({
        type: 'resources_discovered',
        reason: event.reason,
        profile_id: options.profile?.id || null,
        skill_paths: result.skillPaths,
        prompt_paths: result.promptPaths,
        ...(options.getMeta?.() || {}),
      });
      return result;
    });
  };
}
