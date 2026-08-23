/**
 * A cancel that loses a database race must not lose the user's decision.
 *
 * The main cancel transaction competes with the Worker for the Run row, its
 * event ledger and the Outbox. When InnoDB rolls it back, the durable cancel
 * intent goes with it — the caller saw an error and the Run kept running to
 * completion. The intent is written on its own afterwards so the Worker still
 * stops the Run, while the caller is still told the cancel did not complete.
 */

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeKnex, createFakeState } from '../mysql/fake-knex.js';
import { createRepositoryBundle } from '../../src/bootstrap/container.js';
import { CancelRunService } from '../../src/application/cancel-run-service.js';
import { createUlidGenerator } from '../../src/domain/shared/ulid.js';
import { RUN_STATUS } from '../../src/domain/run/run-status.js';
import { MysqlDependencyError } from '../../src/infrastructure/mysql/errors.js';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';
const CONVERSATION = '01K0G2PAV8FPMVC9QHJG7JPN51';
const SESSION = '01K0G2PAV8FPMVC9QHJG7JPN52';
const RUN = '01K0G2PAV8FPMVC9QHJG7JPN53';
const VERSION = '01K0G2PAV8FPMVC9QHJG7JPN54';
const TRIGGER = '01K0G2PAV8FPMVC9QHJG7JPN55';
const TRACE = 'b'.repeat(32);
const NOW = '2026-07-19 01:02:03.004';
const AUTH = {
  provider: 'bff',
  externalOrgId: 'org-ext-1',
  externalUserId: 'user-ext-1',
};

function seed(state, status = RUN_STATUS.RUNNING) {
  state.tables.organizations = [
    { org_id: ORG, name: 'Acme', status: 'active', created_at: NOW, updated_at: NOW },
  ];
  state.tables.users = [
    {
      user_id: USER,
      external_subject: 'bff:user-ext-1',
      display_name: 'Test User',
      email: null,
      status: 'active',
      created_at: NOW,
      updated_at: NOW,
    },
  ];
  state.tables.organization_memberships = [
    { org_id: ORG, user_id: USER, role: 'member', status: 'active', created_at: NOW, updated_at: NOW },
  ];
  state.tables.organization_external_refs = [
    { provider: 'bff', external_subject: 'org-ext-1', org_id: ORG, created_at: NOW },
  ];
  state.tables.runs = [
    {
      run_id: RUN,
      org_id: ORG,
      user_id: USER,
      conversation_id: CONVERSATION,
      agent_session_id: SESSION,
      agent_version_id: VERSION,
      triggering_message_id: TRIGGER,
      source: 'api',
      status,
      status_reason: null,
      queue_name: 'runs',
      attempt: 1,
      trace_id: TRACE,
      trace_state: null,
      next_event_sequence: 0,
      cancel_requested_at: null,
      cancel_reason: null,
      cancel_requested_by: null,
      started_at: NOW,
      completed_at: null,
      created_at: NOW,
      updated_at: NOW,
    },
  ];
  state.tables.run_events = [];
  state.tables.domain_outbox = [];
  state.tables.trace_spans = [];
}

describe('CancelRunService under transaction failure', () => {
  let state;
  let knex;
  let cancel;
  let transactions;

  beforeEach(() => {
    state = createFakeState();
    knex = createFakeKnex(state);
    seed(state);
    const generateId = createUlidGenerator({ now: () => 1_721_278_800_000 });
    transactions = { count: 0, failFirst: null };
    const transactionManager = {
      run: (fn) => {
        transactions.count += 1;
        if (transactions.failFirst && transactions.count === 1) {
          return Promise.reject(transactions.failFirst);
        }
        return knex.transaction(fn);
      },
    };
    cancel = new CancelRunService({
      transactionManager,
      createRepositories: (db) =>
        createRepositoryBundle(db, {
          now: () => new Date(NOW.replace(' ', 'T') + 'Z'),
          generateId,
        }),
      cancelSignal: { async request() {} },
      generateId,
      now: () => new Date(NOW.replace(' ', 'T') + 'Z'),
    });
  });

  it('records cancel intent after a dependency failure and still reports it', async () => {
    transactions.failFirst = new MysqlDependencyError('deadlock; nothing was committed');

    await assert.rejects(
      () => cancel.execute({ runId: RUN, auth: AUTH, reason: 'user pressed cancel' }),
      (err) => err instanceof MysqlDependencyError,
    );

    const row = state.tables.runs[0];
    assert.ok(row.cancel_requested_at, 'the intent must survive the failed transaction');
    assert.equal(row.cancel_requested_by, USER);
    assert.equal(row.cancel_reason, 'user pressed cancel');
    // Intent only: the status transition belongs to the transaction that failed.
    assert.equal(row.status, RUN_STATUS.RUNNING);
    assert.equal(transactions.count, 2, 'one failed attempt, one intent-only write');
  });

  it('writes no intent for a Run that already finished', async () => {
    state.tables.runs[0].status = RUN_STATUS.SUCCEEDED;
    transactions.failFirst = new MysqlDependencyError('deadlock; nothing was committed');

    await assert.rejects(
      () => cancel.execute({ runId: RUN, auth: AUTH }),
      (err) => err instanceof MysqlDependencyError,
    );
    assert.equal(state.tables.runs[0].cancel_requested_at, null);
  });

  it('leaves a non-dependency failure alone', async () => {
    const boom = Object.assign(new Error('bug'), { code: 'SOMETHING_ELSE' });
    transactions.failFirst = boom;

    await assert.rejects(() => cancel.execute({ runId: RUN, auth: AUTH }), (err) => err === boom);
    assert.equal(transactions.count, 1, 'no salvage attempt for an unrelated error');
    assert.equal(state.tables.runs[0].cancel_requested_at, null);
  });
});
