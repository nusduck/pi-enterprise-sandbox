/**
 * 等待通知的 outbox 写入（design `notification-scenarios.md` §3.2）：
 * 与 Run 停住同事务写一行，不带 `runId` / `run_id` 键，不会被 RunEventStream 抢走。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { enqueueRunWaitingNotificationInTxn } from '../../src/application/run-waiting-notification.js';
import {
  AGGREGATE_TYPE_RUN_NOTIFICATION,
  EVENT_TYPE_RUN_WAITING_NOTIFICATION,
} from '../../src/infrastructure/outbox/outbox-status.js';
import {
  RUN_NOTIFICATION_CLAIM_ELIGIBILITY,
  RUN_STREAM_CLAIM_ELIGIBILITY,
  rowMatchesEligibility,
} from '../../src/infrastructure/outbox/eligibility.js';

const RUN = '01W1RUN0000000000000000000';

describe('enqueueRunWaitingNotificationInTxn', () => {
  it('writes one run_notification row with the wait identity in the payload', async () => {
    const inserted: any[] = [];
    await enqueueRunWaitingNotificationInTxn({
      repos: { outbox: { async insert(row: any) { inserted.push(row); } } },
      runId: RUN,
      scope: { orgId: '01W1ORG0000000000000000000', userId: '01W1USER00000000000000000' },
      status: 'WAITING_APPROVAL',
      waitKind: 'approval',
      waitId: '01W1APPR000000000000000000',
      generateId: () => '01W1AB00000000000000000000',
    });
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].aggregateType, AGGREGATE_TYPE_RUN_NOTIFICATION);
    assert.equal(inserted[0].aggregateId, RUN);
    assert.equal(inserted[0].eventType, EVENT_TYPE_RUN_WAITING_NOTIFICATION);
    assert.deepEqual(inserted[0].payloadJson, {
      status: 'WAITING_APPROVAL',
      orgId: '01W1ORG0000000000000000000',
      userId: '01W1USER00000000000000000',
      waitKind: 'approval',
      waitId: '01W1APPR000000000000000000',
    });
    assert.ok(!('runId' in inserted[0].payloadJson) && !('run_id' in inserted[0].payloadJson));
  });

  it('the new row is only claimed by the notification dispatcher', () => {
    const row = {
      aggregate_type: AGGREGATE_TYPE_RUN_NOTIFICATION,
      event_type: EVENT_TYPE_RUN_WAITING_NOTIFICATION,
      payload_json: { status: 'WAITING_INPUT', orgId: 'o', userId: 'u', waitKind: 'input', waitId: 'w' },
    };
    assert.equal(rowMatchesEligibility(row, RUN_NOTIFICATION_CLAIM_ELIGIBILITY), true);
    assert.equal(rowMatchesEligibility(row, RUN_STREAM_CLAIM_ELIGIBILITY), false);
  });
});
