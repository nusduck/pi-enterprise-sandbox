import assert from 'node:assert/strict';
import net from 'node:net';
import { describe, it } from 'node:test';

import {
  emailNotificationCapability,
  resolveEmailNotificationConfig,
} from '../../src/infrastructure/notification/email-config.js';
import {
  buildRunCompletionEmail,
  formatDuration,
  safeTaskTitle,
} from '../../src/infrastructure/notification/run-completion-email.js';
import {
  createSmtpMailer,
  isPermanentMailError,
} from '../../src/infrastructure/notification/smtp-mailer.js';
import { applyRunTransitionInTxn } from '../../src/application/run-transition.js';
import {
  RUN_NOTIFICATION_CLAIM_ELIGIBILITY,
  RUN_STREAM_CLAIM_ELIGIBILITY,
  rowMatchesEligibility,
} from '../../src/infrastructure/outbox/eligibility.js';

const BASE_ENV = {
  NOTIFY_EMAIL_ENABLED: 'true',
  SMTP_HOST: 'smtp.internal',
  NOTIFY_EMAIL_FROM: 'Agent <noreply@example.com>',
  PUBLIC_WEB_BASE_URL: 'https://agent.example.com/',
};

describe('resolveEmailNotificationConfig (fail-closed)', () => {
  it('is off unless explicitly enabled', () => {
    assert.equal(resolveEmailNotificationConfig({}).enabled, false);
    assert.equal(resolveEmailNotificationConfig({ ...BASE_ENV, NOTIFY_EMAIL_ENABLED: 'false' }).enabled, false);
  });

  it('enables with a complete configuration and sane defaults', () => {
    const config = resolveEmailNotificationConfig(BASE_ENV);
    assert.equal(config.enabled, true);
    if (!config.enabled) return;
    assert.deepEqual(config.smtp, { host: 'smtp.internal', port: 587, secure: false, auth: null });
    assert.equal(config.publicWebBaseUrl, 'https://agent.example.com');
    assert.equal(config.minRunDurationMs, 300_000);
    assert.equal(config.timeoutMs, 10_000);
    assert.deepEqual(emailNotificationCapability(config), { available: true, min_run_duration_ms: 300_000 });
  });

  it('reads the SMTP password from a file only', () => {
    const config = resolveEmailNotificationConfig(
      { ...BASE_ENV, SMTP_USER: 'agent', SMTP_PASSWORD_FILE: '/run/secrets/smtp' },
      { readFile: (p) => (p === '/run/secrets/smtp' ? 'pw-from-file\n' : '') },
    );
    assert.equal(config.enabled, true);
    if (config.enabled) assert.deepEqual(config.smtp.auth, { user: 'agent', pass: 'pw-from-file' });
  });

  for (const [label, env, readFile] of [
    ['missing host', { ...BASE_ENV, SMTP_HOST: '' }],
    ['user without password file', { ...BASE_ENV, SMTP_USER: 'agent' }],
    ['unreadable password file', { ...BASE_ENV, SMTP_USER: 'agent', SMTP_PASSWORD_FILE: '/nope' },
      () => { throw new Error('ENOENT'); }],
    ['empty password file', { ...BASE_ENV, SMTP_USER: 'agent', SMTP_PASSWORD_FILE: '/p' }, () => '\n'],
    ['missing sender', { ...BASE_ENV, NOTIFY_EMAIL_FROM: '' }],
    ['invalid sender', { ...BASE_ENV, NOTIFY_EMAIL_FROM: 'not an address' }],
    ['missing public URL', { ...BASE_ENV, PUBLIC_WEB_BASE_URL: '' }],
    ['non-http public URL', { ...BASE_ENV, PUBLIC_WEB_BASE_URL: 'javascript:alert(1)' }],
    ['bad port', { ...BASE_ENV, SMTP_PORT: '99999' }],
    ['timeout above the outbox stale-claim window', { ...BASE_ENV, NOTIFY_EMAIL_TIMEOUT_MS: '120000' }],
    ['non-numeric threshold', { ...BASE_ENV, NOTIFY_MIN_RUN_DURATION_MS: '5m' }],
  ] as Array<[string, Record<string, string>, ((p: string) => string)?]>) {
    it(`stays off with ${label}`, () => {
      const config = resolveEmailNotificationConfig(env, readFile ? { readFile } : {});
      assert.equal(config.enabled, false);
      assert.deepEqual(emailNotificationCapability(config), { available: false, min_run_duration_ms: null });
    });
  }
});

describe('run completion email content', () => {
  it('carries title, status, duration and our link only', () => {
    const mail = buildRunCompletionEmail({
      to: 'dora@example.com',
      status: 'FAILED',
      title: '整理报表，参考 https://evil.example/phish 与 www.evil.example',
      displayName: '多拉',
      durationMs: 3_725_000,
      conversationUrl: 'https://agent.example.com/c/01M1CONV',
    });
    assert.equal(mail.subject, '[任务失败] 整理报表，参考 … 与 …');
    assert.match(mail.text, /运行失败/);
    assert.match(mail.text, /耗时：1 小时 2 分/);
    assert.deepEqual(mail.text.match(/https?:\/\/\S+/g), ['https://agent.example.com/c/01M1CONV']);
  });

  it('bounds and flattens titles', () => {
    assert.equal(safeTaskTitle(null), '未命名任务');
    assert.equal(safeTaskTitle(' a\n\nb '), 'a b');
    assert.equal(Array.from(safeTaskTitle('长'.repeat(200))).length, 80);
    assert.equal(formatDuration(65_000), '1 分 5 秒');
    assert.equal(formatDuration(9_000), '9 秒');
  });
});

describe('SMTP mailer', () => {
  it('classifies permanent vs transient failures', () => {
    assert.equal(isPermanentMailError({ responseCode: 550 }), true);
    assert.equal(isPermanentMailError({ code: 'EENVELOPE' }), true);
    assert.equal(isPermanentMailError({ responseCode: 535, code: 'EAUTH' }), false);
    assert.equal(isPermanentMailError({ responseCode: 421 }), false);
    assert.equal(isPermanentMailError(new Error('ETIMEDOUT')), false);
  });

  it('gives up on a server that never greets within the deadline', async () => {
    const sockets: net.Socket[] = [];
    const server = net.createServer((socket) => { sockets.push(socket); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as net.AddressInfo;
    const mailer = createSmtpMailer({
      smtp: { host: '127.0.0.1', port, secure: false, auth: null },
      from: 'noreply@example.com',
      timeoutMs: 1_000,
    });
    const started = Date.now();
    try {
      await assert.rejects(mailer.send({ to: 'dora@example.com', subject: 's', text: 't' }));
      assert.ok(Date.now() - started < 5_000, 'bounded by the configured timeout');
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('terminal transition writes a notification request', () => {
  function repos() {
    const inserted: any[] = [];
    return {
      inserted,
      repos: {
        runs: { async updateStatusIf() { return { runId: 'R1', status: 'X' }; }, async getById() { return null; } },
        runEvents: { async append(e: any) { return { eventId: e.eventId, sequenceNo: 7 }; } },
        outbox: { async insert(row: any) { inserted.push(row); return row; } },
      },
    };
  }
  let n = 0;
  const generateId = () => `01M1${String(n++).padStart(22, '0')}`;
  const scope = { orgId: '01M1ORG0000000000000000000', userId: '01M1USER000000000000000000' };

  for (const to of ['SUCCEEDED', 'FAILED', 'CANCELLED']) {
    it(`adds a run_notification row on RUNNING → ${to}`, async () => {
      const { repos: r, inserted } = repos();
      await applyRunTransitionInTxn({ repos: r, runId: 'R1', scope, from: 'RUNNING', to, traceId: 't', generateId });
      assert.equal(inserted.length, 2);
      const note = inserted[1];
      assert.equal(note.aggregateType, 'run_notification');
      assert.equal(note.aggregateId, 'R1');
      assert.deepEqual(note.payloadJson, { status: to, ...scope });
      // The RunEventStream publisher must not steal it; the notification publisher must see it.
      const row = { aggregate_type: note.aggregateType, event_type: note.eventType, payload_json: note.payloadJson };
      assert.equal(rowMatchesEligibility(row, RUN_STREAM_CLAIM_ELIGIBILITY), false);
      assert.equal(rowMatchesEligibility(row, RUN_NOTIFICATION_CLAIM_ELIGIBILITY), true);
      assert.equal(rowMatchesEligibility({ aggregate_type: 'run', payload_json: inserted[0].payloadJson }, RUN_NOTIFICATION_CLAIM_ELIGIBILITY), false);
    });
  }

  it('writes nothing extra for non-terminal transitions', async () => {
    const { repos: r, inserted } = repos();
    await applyRunTransitionInTxn({ repos: r, runId: 'R1', scope, from: 'QUEUED', to: 'RUNNING', traceId: 't', generateId });
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].aggregateType, 'run');
  });
});
