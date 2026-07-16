import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeWorkspaceCommand,
  normalizeWorkspacePath,
  normalizeWorkspaceToolParams,
} from '../runtime/workspace-paths.js';
import { createSandboxTools } from '../packages/enterprise-agent-kit/extensions/sandbox-tools/tool-definitions.js';

const ROOT = '/home/sandbox/workspace';

describe('workspace tool path normalization', () => {
  it('maps logical cwd paths and relative paths to one relative contract', () => {
    assert.equal(normalizeWorkspacePath(`${ROOT}/reports/a.csv`), 'reports/a.csv');
    assert.equal(normalizeWorkspacePath(ROOT), '.');
    assert.equal(normalizeWorkspacePath('./reports/a.csv'), 'reports/a.csv');
  });

  it('preserves the conversation-owned persistent temp namespace', () => {
    assert.equal(normalizeWorkspacePath('/tmp/cache/a.json'), '/tmp/cache/a.json');
    assert.equal(normalizeWorkspacePath('/tmp'), '/tmp');
    assert.throws(() => normalizeWorkspacePath('/tmp/../etc/passwd'), /escapes/);
  });

  it('rejects other absolute paths and parent escapes', () => {
    assert.throws(() => normalizeWorkspacePath('/var/sandbox/workspaces/x/a'), /outside/);
    assert.throws(() => normalizeWorkspacePath('/etc/passwd'), /outside/);
    assert.throws(() => normalizeWorkspacePath('../other/a.txt'), /escapes/);
    assert.throws(() => normalizeWorkspacePath('dir/../other/a.txt'), /escapes/);
    assert.throws(() => normalizeWorkspacePath(`${ROOT}//etc/passwd`), /escapes/);
  });

  it('normalizes every path-bearing workspace tool before transport', () => {
    for (const tool of ['read', 'write', 'edit', 'apply_patch', 'submit_artifact', 'ls', 'find', 'grep']) {
      assert.equal(
        normalizeWorkspaceToolParams(tool, { path: `${ROOT}/dir/file.txt` }).path,
        'dir/file.txt',
      );
    }
    assert.equal(
      normalizeWorkspaceToolParams('process_start', { cwd: `${ROOT}/app` }).cwd,
      'app',
    );
    assert.equal(
      normalizeWorkspaceToolParams('process_start', { cwd: '/tmp/service' }).cwd,
      '/tmp/service',
    );
  });

  it('maps the logical cwd in bash and managed-process commands', () => {
    assert.equal(
      normalizeWorkspaceCommand(`cat ${ROOT}/notes/a.txt && cd ${ROOT}`),
      'cat ./notes/a.txt && cd .',
    );
    assert.equal(
      normalizeWorkspaceToolParams('process_start', {
        command: `node ${ROOT}/app/server.js`,
        cwd: `${ROOT}/app`,
      }).command,
      'node ./app/server.js',
    );
    assert.equal(normalizeWorkspaceCommand('/home/sandbox/skill/x/run.py'), '/home/sandbox/skill/x/run.py');
  });

  it('preserves absolute Skill paths for the separate Skill policy boundary', () => {
    const skill = '/home/sandbox/skill/pdf/SKILL.md';
    const params = normalizeWorkspaceToolParams('read', { path: skill }, {
      isSkillPath: (value) => value.startsWith('/home/sandbox/skill/'),
    });
    assert.equal(params.path, skill);
  });

  it('sends the normalized path through the actual tool transport', async () => {
    const calls = [];
    const client = {
      async readFile(sessionId, filePath) {
        calls.push({ sessionId, filePath });
        return { content: 'ok', size: 2 };
      },
    };
    const read = createSandboxTools({ client, sessionId: 'sandbox-1' })
      .find((tool) => tool.name === 'read');
    const result = await read.execute('read-1', { path: `${ROOT}/reports/a.csv` });
    assert.equal(result.content[0].text, 'ok');
    assert.deepEqual(calls, [{ sessionId: 'sandbox-1', filePath: 'reports/a.csv' }]);
  });

  it('sends normalized logical paths through the actual bash transport', async () => {
    const commands = [];
    const client = {
      async approvalCheck() {
        return { status: 'approved', risk_level: 'medium' };
      },
      async executeCommand(_sessionId, command) {
        commands.push(command);
        return { exit_code: 0, stdout_preview: 'ok', stderr_preview: '' };
      },
    };
    const bash = createSandboxTools({ client, sessionId: 'sandbox-1' })
      .find((tool) => tool.name === 'bash');
    await bash.execute('bash-1', { command: `cat ${ROOT}/reports/a.csv` });
    assert.deepEqual(commands, ['cat ./reports/a.csv']);
  });
});
