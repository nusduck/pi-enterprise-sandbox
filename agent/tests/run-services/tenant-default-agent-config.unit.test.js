import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { AgentConfigValidator } from '../../src/application/agent-config-validator.js';
import { SystemSkillCatalog } from '../../src/skills/system-catalog.js';
import {
  defaultAgentConfigJson,
  tenantDefaultAgentConfigJson,
} from '../../src/infrastructure/mysql/repositories/agent-catalog-repository.js';

// 用仓库自带的 ./skills 当系统层：与 compose 挂载的是同一份 release 内容。
const REPO_SKILLS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../skills');

async function validatorWithRepoSkills() {
  const catalog = new SystemSkillCatalog({ root: REPO_SKILLS, cacheMs: 0 });
  const validator = new AgentConfigValidator({
    env: { MCP_SERVERS_JSON: '[]' },
    platformToolNames: ['bash', 'read'],
    systemSkillCatalog: catalog,
  });
  await validator.refreshSkills();
  return { validator, systemNames: (await catalog.list()).map((entry) => entry.name) };
}

describe('tenantDefaultAgentConfigJson', () => {
  it('explicitly binds every system skill plus the caller\'s enabled skills', async () => {
    const config = tenantDefaultAgentConfigJson();
    assert.deepEqual(config.skillPolicy, {
      system: { mode: 'all', names: [] },
      org: [],
      user: 'allow',
    });
    assert.ok(config.systemPrompt.includes('SKILL.md'));

    const { validator, systemNames } = await validatorWithRepoSkills();
    assert.ok(systemNames.length > 0, 'repo skills/ must provide system packages');
    const result = validator.validate(config);
    assert.deepEqual(result.errors, []);
    assert.equal(result.valid, true);
  });

  it('does not leak the default persona into user-created agents', () => {
    assert.equal(defaultAgentConfigJson().systemPrompt, '');
    assert.equal('skillPolicy' in defaultAgentConfigJson(), false);
  });
});
