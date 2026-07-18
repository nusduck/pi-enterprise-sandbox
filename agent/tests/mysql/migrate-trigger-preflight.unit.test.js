/**
 * Unit tests: MySQL trigger / binary-log preflight (no live MySQL).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertMysqlTriggerMigrationCapability,
  coerceMysqlBool,
  evaluateTriggerMigrationCapability,
  extractFirstRow,
  inspectMysqlTriggerMigrationCapability,
  MysqlTriggerCapabilityError,
  MYSQL_TRIGGER_BINLOG_BLOCKED,
} from '../../src/infrastructure/mysql/migrate-trigger-preflight.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '../../..');

describe('coerceMysqlBool / extractFirstRow', () => {
  it('coerces ON/OFF and 0/1', () => {
    assert.equal(coerceMysqlBool(1), true);
    assert.equal(coerceMysqlBool(0), false);
    assert.equal(coerceMysqlBool('ON'), true);
    assert.equal(coerceMysqlBool('OFF'), false);
    assert.equal(coerceMysqlBool(null), null);
  });

  it('extracts first row from knex mysql2 [rows, fields]', () => {
    const row = extractFirstRow([[{ log_bin: 1, trust_creators: 0 }], []]);
    assert.deepEqual(row, { log_bin: 1, trust_creators: 0 });
  });
});

describe('evaluateTriggerMigrationCapability', () => {
  it('ok when log_bin off', () => {
    assert.equal(
      evaluateTriggerMigrationCapability({ logBin: false, trustCreators: false })
        .ok,
      true,
    );
  });

  it('ok when log_bin on and trust on', () => {
    assert.equal(
      evaluateTriggerMigrationCapability({ logBin: true, trustCreators: true })
        .ok,
      true,
    );
  });

  it('blocked when log_bin on and trust off', () => {
    const d = evaluateTriggerMigrationCapability({
      logBin: true,
      trustCreators: false,
    });
    assert.equal(d.ok, false);
    assert.match(d.reason, /log_bin_trust_function_creators/);
    assert.match(d.reason, /will not SET GLOBAL/i);
    assert.match(d.reason, /non-SUPER/i);
    assert.match(d.reason, /docker-compose/);
    assert.match(d.reason, /mysql-partial-migration-recovery/);
  });

  it('blocked when variables unreadable', () => {
    const d = evaluateTriggerMigrationCapability({
      logBin: null,
      trustCreators: null,
    });
    assert.equal(d.ok, false);
  });
});

describe('assertMysqlTriggerMigrationCapability', () => {
  it('passes when trust_creators=1 under binary log', async () => {
    const knex = {
      raw: async () => [[{ log_bin: 1, trust_creators: 1 }], []],
    };
    await assertMysqlTriggerMigrationCapability(/** @type {any} */ (knex));
  });

  it('fail-closed with MYSQL_TRIGGER_BINLOG_BLOCKED', async () => {
    const knex = {
      raw: async () => [[{ log_bin: 1, trust_creators: 0 }], []],
    };
    await assert.rejects(
      () => assertMysqlTriggerMigrationCapability(/** @type {any} */ (knex)),
      (err) => {
        assert.ok(err instanceof MysqlTriggerCapabilityError);
        assert.equal(err.code, MYSQL_TRIGGER_BINLOG_BLOCKED);
        assert.equal(err.logBin, true);
        assert.equal(err.trustCreators, false);
        assert.match(err.message, /external\/managed/i);
        return true;
      },
    );
  });

  it('inspect returns decision for operators', async () => {
    const knex = {
      raw: async () => [[{ log_bin: 'ON', trust_creators: 'OFF' }], []],
    };
    const r = await inspectMysqlTriggerMigrationCapability(
      /** @type {any} */ (knex),
    );
    assert.equal(r.logBin, true);
    assert.equal(r.trustCreators, false);
    assert.equal(r.decision.ok, false);
  });
});

describe('deploy docs + compose document trigger gate', () => {
  it('runbook has triggers-and-binary-logging section', () => {
    const runbook = readFileSync(
      path.join(
        REPO_ROOT,
        'docs/runbooks/mysql-partial-migration-recovery.md',
      ),
      'utf8',
    );
    assert.match(runbook, /# Triggers and binary logging/);
    assert.match(runbook, /log-bin-trust-function-creators=1/);
    assert.match(runbook, /External \/ managed MySQL/);
    assert.match(runbook, /will not.*SET GLOBAL/i);
    assert.match(runbook, /MYSQL_TRIGGER_BINLOG_BLOCKED/);
    assert.doesNotMatch(runbook, /GRANT SUPER/i);
  });

  it('deployment.md documents compose flag and managed fail-closed', () => {
    const dep = readFileSync(
      path.join(REPO_ROOT, 'docs/deployment.md'),
      'utf8',
    );
    assert.match(dep, /log-bin-trust-function-creators=1/);
    assert.match(dep, /MYSQL_TRIGGER_BINLOG_BLOCKED/);
    assert.match(dep, /non-SUPER/);
    assert.match(dep, /external\/managed/i);
  });

  it('compose files set mysqld trust flag', () => {
    for (const rel of ['docker-compose.yml', 'docker-compose.prod.yml']) {
      const text = readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      assert.match(
        text,
        /--log-bin-trust-function-creators=1/,
        rel,
      );
      // No SQL privilege elevation statements for the app role.
      assert.doesNotMatch(text, /GRANT\s+SUPER\s+ON\s+/i);
      assert.doesNotMatch(text, /IDENTIFIED\s+WITH\s+.*SUPER/i);
    }
  });
});
