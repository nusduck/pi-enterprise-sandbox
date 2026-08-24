import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCreateRunBody } from '../src/routes/runs.js';

describe('run model selection', () => {
  it('normalizes snake_case and camelCase model ids for Agent forwarding', () => {
    const snake = normalizeCreateRunBody({
      messages: [{ role: 'user', content: 'hello' }],
      model_id: 'deepseek-v4-flash-vision-exp',
    });
    const camel = normalizeCreateRunBody({
      messages: [{ role: 'user', content: 'hello' }],
      modelId: 'deepseek-v4-pro',
    });
    assert.equal(snake.model_id, 'deepseek-v4-flash-vision-exp');
    assert.equal(camel.model_id, 'deepseek-v4-pro');
  });
});
