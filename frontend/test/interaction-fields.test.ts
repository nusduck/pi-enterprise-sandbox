import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isAskUserToolName,
  parseAskUserFields,
  summarizeInteractionResult,
} from '../src/widgets/runtime-steps/interactionFields.ts';

describe('interactionFields', () => {
  it('parses ask_user tool input for display', () => {
    const fields = parseAskUserFields({
      title: '查询天气',
      message: '想查哪个城市？',
      placeholder: '例如：北京',
      interaction_type: 'input',
    });
    assert.equal(fields.title, '查询天气');
    assert.equal(fields.message, '想查哪个城市？');
    assert.equal(fields.placeholder, '例如：北京');
    assert.equal(fields.interactionType, 'input');
  });

  it('prefers pendingInput over tool args', () => {
    const fields = parseAskUserFields(
      { title: 'stale', interaction_type: 'input' },
      {
        title: 'live title',
        message: 'live message',
        interactionType: 'select',
        options: ['A', 'B'],
      },
    );
    assert.equal(fields.title, 'live title');
    assert.equal(fields.message, 'live message');
    assert.equal(fields.interactionType, 'select');
    assert.deepEqual(fields.options, ['A', 'B']);
  });

  it('summarizes interaction results', () => {
    assert.equal(summarizeInteractionResult(true), 'Confirmed');
    assert.equal(summarizeInteractionResult(false), 'Declined');
    assert.equal(summarizeInteractionResult('上海'), '上海');
    assert.equal(
      summarizeInteractionResult({ content: [{ type: 'text', text: 'ok' }] }),
      'ok',
    );
  });

  it('detects ask_user tool name', () => {
    assert.equal(isAskUserToolName('ask_user'), true);
    assert.equal(isAskUserToolName('bash'), false);
  });
});
