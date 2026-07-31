import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCreateRunBody } from '../src/routes/runs.js';

describe('run model selection', () => {
  it('normalizes snake_case and camelCase model ids for Agent forwarding', () => {
    const snake = normalizeCreateRunBody({
      messages: [{ role: 'user', content: 'hello' }],
      model_id: 'gpt-5.5',
    });
    const camel = normalizeCreateRunBody({
      messages: [{ role: 'user', content: 'hello' }],
      modelId: 'mimo-v2.5',
    });
    assert.equal(snake.model_id, 'gpt-5.5');
    assert.equal(camel.model_id, 'mimo-v2.5');
  });
});
