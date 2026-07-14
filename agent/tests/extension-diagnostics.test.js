import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { getExtensionDiagnostics } from '../application/extension-diagnostics-service.js';

let root;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'extension-diagnostics-'));
  const skillDir = join(root, 'workspace-helper');
  await mkdir(skillDir);
  await writeFile(
    join(skillDir, 'SKILL.md'),
    [
      '---',
      'name: workspace-helper',
      'description: Helps with workspace files.',
      '---',
      '',
      '# Workspace helper',
      '',
    ].join('\n'),
    'utf8',
  );
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test('extension diagnostics includes valid packages from configured skill roots', () => {
  const diagnostics = getExtensionDiagnostics({ skillRoots: [root] });
  const skill = diagnostics.skills.find((item) => item.name === 'workspace-helper');
  assert.ok(skill);
  assert.equal(skill.description, 'Helps with workspace files.');
  assert.equal(skill.source, root);
  assert.equal(skill.path, join(root, 'workspace-helper', 'SKILL.md'));
});
