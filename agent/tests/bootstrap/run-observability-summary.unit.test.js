import assert from 'node:assert/strict';
import { test } from 'node:test';

import { summarizeRunObservability } from '../../src/bootstrap/http-main.js';

test('Run list observability summary reads durable model and message events', () => {
  const summary = summarizeRunObservability([
    {
      eventType: 'model.request.completed',
      payloadJson: { model: { id: 'gpt-5.6' } },
    },
    {
      eventType: 'message.completed',
      payloadJson: { usage: { input_tokens: 100, output_tokens: 25 } },
    },
    {
      eventType: 'message.completed',
      payloadJson: { usage: { total_tokens: 10 } },
    },
  ]);
  assert.equal(summary.modelId, 'gpt-5.6');
  assert.deepEqual(summary.usage, {
    input_tokens: 100,
    output_tokens: 25,
    total_tokens: 135,
  });
});
