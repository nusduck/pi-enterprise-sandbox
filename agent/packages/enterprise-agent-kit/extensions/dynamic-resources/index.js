import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export function createDynamicResourcesExtension(options = {}) {
  const packageSkillPath = join(PACKAGE_ROOT, 'skills');
  const packagePromptPath = join(PACKAGE_ROOT, 'prompts');
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
