import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NotificationPublisher } from '../../src/infrastructure/notification/notification-publisher.js';
import { PermanentMailError } from '../../src/infrastructure/notification/smtp-mailer.js';
import {
  RUN_NOTIFICATION_CLAIM_ELIGIBILITY,
} from '../../src/infrastructure/outbox/eligibility.js';

const ORG = '01M1ORG0000000000000000000';
const USER = '01M1USER000000000000000000';
const RUN = '01M1RUN0000000000000000000';

const ENABLED = {
  enabled: true as const,
  smtp: { host: 'smtp.test', port: 587, secure: false, auth: null },
  from: 'noreply@example.com',
  timeoutMs: 5_000,
  minRunDurationMs: 60_000,
  publicWebBaseUrl: 'https://agent.example.com',
};

function context(overrides: Record<string, unknown> = {}) {
  return {
    runId: RUN,
    orgId: ORG,
    userId: USER,
    parentRunId: null,
    status: 'SUCCEEDED',
    conversationId: '01M1CONV000000000000000000',
    conversationTitle: '季度报表',
    createdAt: '2026-09-28T01:00:00.000Z',
    completedAt: '2026-09-28T01:10:00.000Z',
    displayName: '多拉',
    email: 'dora@example.com',
    notifyRunComplete: true,
    ...overrides,
  };
}

function harness(opts: {
  ctx?: any;
  config?: any;
  mailError?: unknown;
  existingDelivery?: string;
  retryOutcome?: 'retry' | 'failed';
  payload?: Record<string, unknown>;
} = {}) {
  const calls: Record<string, any[]> = {
    claim: [], published: [], failed: [], retry: [], begin: [], sent: [], failure: [], mail: [], load: [],
  };
  const outbox = {
    async claimBatch(args: any) {
      calls.claim.push(args);
      return [{
        outboxId: 'OB1',
        claimToken: 'TOK',
        aggregateId: RUN,
        attempts: 1,
        payloadJson: opts.payload ?? { status: 'SUCCEEDED', orgId: ORG, userId: USER },
      }];
    },
    async markPublished(id: string, token: string) { calls.published.push([id, token]); return true; },
    async markFailed(id: string, token: string, err: unknown) { calls.failed.push([id, token, err]); return true; },
    async markPendingForRetry(id: string, token: string, err: unknown) {
      calls.retry.push([id, token, err]);
      return opts.retryOutcome ?? 'retry';
    },
  };
  const store: any = {
    async loadRunContext(runId: string, scope: any) {
      calls.load.push([runId, scope]);
      return opts.ctx === undefined ? context() : opts.ctx;
    },
    async begin(input: any) {
      calls.begin.push(input);
      if (opts.existingDelivery) {
        return { created: false, delivery: { deliveryId: 'D0', status: opts.existingDelivery, attempts: 1 } };
      }
      return { created: true, delivery: { deliveryId: input.deliveryId, status: input.status, attempts: 0 } };
    },
    async markSent(id: string) { calls.sent.push(id); },
    async recordFailure(id: string, err: unknown, final: boolean) { calls.failure.push([id, err, final]); },
  };
  const mailer = {
    async send(message: any) {
      calls.mail.push(message);
      if (opts.mailError) throw opts.mailError;
    },
  };
  const publisher = new NotificationPublisher({
    outbox,
    store,
    mailer,
    config: opts.config ?? ENABLED,
    generateId: () => '01M1DELIVERY00000000000000',
  });
  return { publisher, calls };
}

describe('NotificationPublisher', () => {
  it('claims only run_notification rows', async () => {
    const { publisher, calls } = harness();
    await publisher.publishOnce();
    assert.deepEqual(calls.claim[0].eligibility, RUN_NOTIFICATION_CLAIM_ELIGIBILITY);
  });

  for (const status of ['SUCCEEDED', 'FAILED', 'CANCELLED']) {
    it(`mails the owner once for a ${status} run they opted into`, async () => {
      const { publisher, calls } = harness({ ctx: context({ status }) });
      const { outcomes } = await publisher.publishOnce();
      assert.deepEqual(outcomes, ['sent']);
      assert.equal(calls.mail.length, 1);
      assert.equal(calls.mail[0].to, 'dora@example.com');
      assert.match(calls.mail[0].text, /https:\/\/agent\.example\.com\/c\/01M1CONV000000000000000000/);
      assert.deepEqual(calls.load[0], [RUN, { orgId: ORG, userId: USER }], 'recipient comes from the ledger scope');
      assert.equal(calls.begin[0].status, 'sending');
      assert.equal(calls.begin[0].recipientHash.length, 64, 'only a digest of the address is stored');
      assert.deepEqual(calls.sent, ['01M1DELIVERY00000000000000']);
      assert.deepEqual(calls.published, [['OB1', 'TOK']]);
    });
  }

  it('settles without mailing when the user has not opted in', async () => {
    const { publisher, calls } = harness({ ctx: context({ notifyRunComplete: false }) });
    assert.deepEqual((await publisher.publishOnce()).outcomes, ['opted_out']);
    assert.equal(calls.mail.length, 0);
    assert.equal(calls.begin.length, 0);
    assert.equal(calls.published.length, 1);
  });

  it('records a skipped delivery when the opted-in user has no email', async () => {
    const { publisher, calls } = harness({ ctx: context({ email: null }) });
    assert.deepEqual((await publisher.publishOnce()).outcomes, ['no_email']);
    assert.equal(calls.mail.length, 0);
    assert.equal(calls.begin[0].status, 'skipped');
    assert.equal(calls.begin[0].recipientHash, null);
    assert.equal(calls.published.length, 1);
  });

  it('does not mail child runs or runs shorter than the threshold', async () => {
    const child = harness({ ctx: context({ parentRunId: '01M1PARENT0000000000000000' }) });
    assert.deepEqual((await child.publisher.publishOnce()).outcomes, ['child_run']);
    const short = harness({ ctx: context({ completedAt: '2026-09-28T01:00:30.000Z' }) });
    assert.deepEqual((await short.publisher.publishOnce()).outcomes, ['too_short']);
    for (const h of [child, short]) {
      assert.equal(h.calls.mail.length, 0);
      assert.equal(h.calls.published.length, 1);
    }
  });

  it('only settles rows when the capability is not configured', async () => {
    const { publisher, calls } = harness({ config: { enabled: false, reason: 'off' } });
    assert.deepEqual((await publisher.publishOnce()).outcomes, ['disabled']);
    assert.equal(calls.load.length, 0);
    assert.equal(calls.mail.length, 0);
    assert.equal(calls.published.length, 1);
  });

  it('fails closed when the run does not match the recorded org/user', async () => {
    const mismatch = harness({ ctx: null });
    assert.deepEqual((await mismatch.publisher.publishOnce()).outcomes, ['not_found']);
    const missingScope = harness({ payload: { status: 'SUCCEEDED' } });
    assert.deepEqual((await missingScope.publisher.publishOnce()).outcomes, ['not_found']);
    assert.equal(missingScope.calls.load.length, 0, 'no ledger read without a scope');
    for (const h of [mismatch, missingScope]) {
      assert.equal(h.calls.mail.length, 0);
      assert.equal(h.calls.failed.length, 1);
      assert.equal(h.calls.published.length, 0);
    }
  });

  it('does not send a second mail when a redelivered row finds the delivery settled', async () => {
    for (const settled of ['sent', 'skipped', 'failed']) {
      const { publisher, calls } = harness({ existingDelivery: settled });
      assert.deepEqual((await publisher.publishOnce()).outcomes, ['already_settled']);
      assert.equal(calls.mail.length, 0);
      assert.equal(calls.published.length, 1);
    }
  });

  it('resends when a redelivered row finds the previous attempt unresolved', async () => {
    const { publisher, calls } = harness({ existingDelivery: 'sending' });
    assert.deepEqual((await publisher.publishOnce()).outcomes, ['sent']);
    assert.equal(calls.mail.length, 1);
    assert.deepEqual(calls.sent, ['D0']);
  });

  it('marks permanent SMTP rejections failed without retrying', async () => {
    const rejected = Object.assign(new Error('550 mailbox unavailable'), { responseCode: 550 });
    for (const mailError of [rejected, new PermanentMailError('bad address')]) {
      const { publisher, calls } = harness({ mailError });
      assert.deepEqual((await publisher.publishOnce()).outcomes, ['failed']);
      assert.equal(calls.retry.length, 0);
      assert.equal(calls.failed.length, 1);
      assert.equal(calls.failure[0][2], true);
      assert.equal(calls.sent.length, 0);
    }
  });

  it('hands transient errors to the outbox backoff and records the final give-up', async () => {
    const timeout = new Error('SMTP send exceeded 5000ms');
    const retry = harness({ mailError: timeout });
    assert.deepEqual((await retry.publisher.publishOnce()).outcomes, ['retry']);
    assert.equal(retry.calls.retry.length, 1);
    assert.equal(retry.calls.failure[0][2], false, 'delivery stays sending while retries remain');

    const exhausted = harness({ mailError: timeout, retryOutcome: 'failed' });
    assert.deepEqual((await exhausted.publisher.publishOnce()).outcomes, ['failed']);
    assert.equal(exhausted.calls.failure[0][2], true);
    for (const h of [retry, exhausted]) assert.equal(h.calls.published.length, 0);
  });

  it('requires a mailer when the capability is enabled', () => {
    assert.throws(() => new NotificationPublisher({
      outbox: {}, store: {} as any, mailer: null, config: ENABLED, generateId: () => 'x',
    }), /requires a mailer/);
  });
});
