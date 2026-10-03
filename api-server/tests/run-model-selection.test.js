import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCreateRunBody } from '../src/routes/runs.js';

describe('run model selection', () => {
  it('forwards the snake_case model id to the Agent', () => {
    const snake = normalizeCreateRunBody({
      messages: [{ role: 'user', content: 'hello' }],
      model_id: 'deepseek-v4-flash-vision-exp',
    });
    assert.equal(snake.model_id, 'deepseek-v4-flash-vision-exp');
  });

  it('drops the retired camelCase modelId alias', () => {
    const camel = normalizeCreateRunBody({
      messages: [{ role: 'user', content: 'hello' }],
      modelId: 'deepseek-v4-pro',
    });
    assert.equal(camel.model_id, undefined);
  });
});
