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
