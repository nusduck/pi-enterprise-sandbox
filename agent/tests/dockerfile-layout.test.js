import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const agentRoot = join(here, '..');
const repositoryRoot = join(agentRoot, '..');
const dockerfile = readFileSync(join(agentRoot, 'Dockerfile'), 'utf8');
const compose = readFileSync(join(repositoryRoot, 'docker-compose.yml'), 'utf8');

describe('Agent image workspace boundary', () => {
  it('creates the logical Pi cwd without linking a physical workspace', () => {
    assert.match(dockerfile, /mkdir -p[^\n]*\/home\/sandbox\/workspace/);
    assert.doesNotMatch(dockerfile, /\bln\s+-s(?:f)?\b[^\n]*\/home\/sandbox\/workspace/);
  });

  it('does not mount a physical workspace into agent or worker services', () => {
    const agentServices = compose.slice(
      compose.indexOf('\n  agent:\n'),
      compose.indexOf('\n  sandbox:\n'),
    );

    assert.ok(agentServices.length > 0, 'agent service block must be present');
    assert.doesNotMatch(agentServices, /\/var\/sandbox\/workspaces/);
    assert.doesNotMatch(agentServices, /:\/home\/sandbox\/workspace(?::|\s|$)/m);
  });
});
