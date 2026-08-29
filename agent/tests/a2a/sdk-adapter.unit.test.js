import assert from 'node:assert/strict';
import test from 'node:test';
import {
  encodeA2aSseFromSdk,
  mapRunStatusToSdkTaskState,
} from '../../src/application/a2a/sdk-adapter.js';
import { RUN_STATUS } from '../../src/domain/run/run-status.js';

test('A2A SSE 帧走 @a2a-js/sdk formatSSEEvent', () => {
  const frame = encodeA2aSseFromSdk({ kind: 'status-update', status: { state: 'working' } });
  assert.equal(frame.startsWith('data: '), true);
  assert.equal(frame.endsWith('\n\n'), true);
  const parsed = JSON.parse(frame.slice('data: '.length).trim());
  assert.equal(parsed.kind, 'status-update');
});

test('Run 状态投影到 SDK Task state 词汇', () => {
  assert.equal(mapRunStatusToSdkTaskState(RUN_STATUS.QUEUED), 'submitted');
  assert.equal(mapRunStatusToSdkTaskState(RUN_STATUS.WAITING_APPROVAL), 'auth-required');
});
