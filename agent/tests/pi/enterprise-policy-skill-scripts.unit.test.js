import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateLocalArgGuards } from '../../src/extensions/enterprise-policy/arg-guards.js';

const script = '/home/sandbox/skill/pdf/scripts/render.py';

test('policy allows a simple declared Skill script invocation', () => {
  assert.equal(
    evaluateLocalArgGuards('bash', { command: `python3 ${script} --input x.md` }),
    null,
  );
});

test('policy allows a Skill script nested under scripts/', () => {
  // Bundled packages ship helper modules in subdirectories, e.g.
  // xlsx/scripts/office/pack.py. Requiring a flat scripts/ made those
  // unrunnable through the only entrypoint the guard allows.
  assert.equal(
    evaluateLocalArgGuards('bash', {
      command: 'python3 /home/sandbox/skill/xlsx/scripts/office/pack.py book.xlsx',
    }),
    null,
  );
});

test('policy rejects traversal that only reads as a scripts/ path', () => {
  const result = evaluateLocalArgGuards('bash', {
    command: 'python3 /home/sandbox/skill/pdf/scripts/../hidden.py',
  });
  assert.equal(result?.reasonCode, 'SKILL_SCRIPT_COMMAND_DENIED');
});

test('policy rejects shell composition or non-script Skill paths', () => {
  for (const command of [
    `python3 ${script}; id`,
    `cat /home/sandbox/skill/pdf/SKILL.md`,
    `python3 /home/sandbox/skill/pdf/render.py`,
  ]) {
    const result = evaluateLocalArgGuards('bash', { command });
    assert.equal(result?.reasonCode, 'SKILL_SCRIPT_COMMAND_DENIED');
  }
});
