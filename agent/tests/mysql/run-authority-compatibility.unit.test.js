/**
 * PR-04 T1: RunRepository CAS, external refs, migration static checks.
 * Offline — no MySQL/network/Docker.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RunRepository,
  resolveRunListLimit,
  normalizeExpectedStatuses,
  RUN_LIST_MAX_LIMIT,
} from '../../src/infrastructure/mysql/repositories/run-repository.js';
import {
  ExternalReferenceRepository,
} from '../../src/infrastructure/mysql/repositories/external-reference-repository.js';
import {
  OrganizationRepository,
  formatUserExternalSubject,
  parseUserExternalSubject,
} from '../../src/infrastructure/mysql/repositories/organization-repository.js';
import {
  ConflictError,
  NotFoundError,
} from '../../src/infrastructure/mysql/errors.js';
import {
  ORG_EXTERNAL_REFS_TABLE,
  CONV_EXTERNAL_REFS_TABLE,
  up as migrationUp,
  down as migrationDown,
} from '../../src/infrastructure/mysql/migrations/20260718000003_run_authority_compatibility.js';
import { NON_TERMINAL_RUN_STATUSES } from '../../src/domain/run/run-status.js';
import { isLegacyOrUuidIdentity, isUlid } from '../../src/domain/shared/ulid.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(
  __dirname,
  '../../src/infrastructure/mysql/migrations',
);
const MIGRATION_PATH = path.join(
  MIGRATIONS_DIR,
  '20260718000003_run_authority_compatibility.js',
);

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';
const USER2 = '01K0G2PAV8FPMVC9QHJG7JPN5A';
const RUN = '01K0G2PAV8FPMVC9QHJG7JPN53';
const RUN2 = '01K0G2PAV8FPMVC9QHJG7JPN54';
const CONV = '01K0G2PAV8FPMVC9QHJG7JPN51';
const SESS = '01K0G2PAV8FPMVC9QHJG7JPN52';
const VER = '01K0G2PAV8FPMVC9QHJG7JPN5C';
const MSG = '01K0G2PAV8FPMVC9QHJG7JPN57';
const TRACE = 'a'.repeat(32);
const FIXED_NOW = new Date('2026-07-18T05:00:00.000Z');

/**
 * Fake knex with whereIn / owner filters for runs + external ref tables.
 */
function createAuthorityFake() {
  /** @type {Record<string, Record<string, unknown>[]>} */
  const tables = {
    runs: [],
    organization_external_refs: [],
    conversation_external_refs: [],
    users: [],
    organizations: [],
    organization_memberships: [],
  };

  /**
   * @param {string} tableName
   */
  function createQuery(tableName) {
    /** @type {Array<[string, unknown]>} */
    const filters = [];
    /** @type {Array<[string, unknown[]]>} */
    const inFilters = [];
    /** @type {{ col: string, dir: string } | null} */
    let order = null;
    /** @type {number | null} */
    let limitN = null;
    /** @type {'select'|'insert'|'update'} */
    let type = 'select';
    /** @type {Record<string, unknown> | null} */
    let insertRow = null;
    /** @type {Record<string, unknown> | null} */
    let updates = null;

    const rowMatches = (row) => {
      for (const [col, val] of filters) {
        if (row[col] !== val) return false;
      }
      for (const [col, vals] of inFilters) {
        if (!vals.includes(row[col])) return false;
      }
      return true;
    };

    const api = {
      where(colOrObj, val) {
        if (typeof colOrObj === 'object' && colOrObj !== null) {
          for (const [k, v] of Object.entries(colOrObj)) {
            filters.push([k, v]);
          }
        } else {
          filters.push([String(colOrObj), val]);
        }
        return api;
      },
      andWhere(colOrObj, val) {
        return api.where(colOrObj, val);
      },
      whereIn(col, vals) {
        inFilters.push([String(col), [...vals]]);
        return api;
      },
      orderBy(col, dir = 'asc') {
        order = { col, dir };
        return api;
      },
      limit(n) {
        limitN = n;
        return api;
      },
      insert(row) {
        type = 'insert';
        insertRow = row;
        return Promise.resolve().then(() => {
          const table = tables[tableName] || (tables[tableName] = []);
          // PK uniqueness heuristics
          if (tableName === 'organization_external_refs') {
            const dup = table.some(
              (r) =>
                r.provider === row.provider &&
                r.external_subject === row.external_subject,
            );
            if (dup) {
              const err = new Error('Duplicate entry');
              // @ts-ignore
              err.code = 'ER_DUP_ENTRY';
              throw err;
            }
          }
          if (tableName === 'conversation_external_refs') {
            const dup = table.some(
              (r) =>
                r.org_id === row.org_id &&
                r.user_id === row.user_id &&
                r.provider === row.provider &&
                r.external_subject === row.external_subject,
            );
            if (dup) {
              const err = new Error('Duplicate entry');
              // @ts-ignore
              err.code = 'ER_DUP_ENTRY';
              throw err;
            }
          }
          if (tableName === 'users') {
            const dup = table.some(
              (r) =>
                r.user_id === row.user_id ||
                r.external_subject === row.external_subject,
            );
            if (dup) {
              const err = new Error('Duplicate entry');
              // @ts-ignore
              err.code = 'ER_DUP_ENTRY';
              throw err;
            }
          }
          if (tableName === 'organization_memberships') {
            const dup = table.some(
              (r) => r.org_id === row.org_id && r.user_id === row.user_id,
            );
            if (dup) {
              const err = new Error('Duplicate entry');
              // @ts-ignore
              err.code = 'ER_DUP_ENTRY';
              throw err;
            }
          }
          table.push({ ...row });
          return 1;
        });
      },
      update(patch) {
        type = 'update';
        updates = patch;
        return Promise.resolve().then(() => {
          const table = tables[tableName] || [];
          let n = 0;
          for (const row of table) {
            if (rowMatches(row)) {
              Object.assign(row, updates);
              n += 1;
            }
          }
          return n;
        });
      },
      first() {
        return Promise.resolve().then(() => {
          const table = tables[tableName] || [];
          return table.find(rowMatches);
        });
      },
      then(resolve, reject) {
        return Promise.resolve()
          .then(() => {
            void type;
            void insertRow;
            let rows = (tables[tableName] || []).filter(rowMatches);
            if (order) {
              const { col, dir } = order;
              rows = [...rows].sort((a, b) => {
                if (a[col] === b[col]) return 0;
                if (a[col] > b[col]) return dir === 'desc' ? -1 : 1;
                return dir === 'desc' ? 1 : -1;
              });
            }
            if (limitN != null) rows = rows.slice(0, limitN);
            return rows;
          })
          .then(resolve, reject);
      },
    };
    return api;
  }

  /** @type {any} */
  const knex = (table) => createQuery(table);
  knex.__tables = tables;
  knex.isTransaction = false;
  return knex;
}

function seedRun(knex, overrides = {}) {
  const row = {
    run_id: RUN,
    org_id: ORG,
    user_id: USER,
    conversation_id: CONV,
    agent_session_id: SESS,
    agent_version_id: VER,
    triggering_message_id: MSG,
    source: 'web',
    status: 'ACCEPTED',
    status_reason: null,
    queue_name: 'runs',
    attempt: 0,
    trace_id: TRACE,
    next_event_sequence: 0,
    started_at: null,
    completed_at: null,
    created_at: '2026-07-18 04:00:00.000',
    updated_at: '2026-07-18 04:00:00.000',
    ...overrides,
  };
  knex.__tables.runs.push(row);
  return row;
}

describe('RunRepository list limits + conditional status', () => {
  /** @type {ReturnType<typeof createAuthorityFake>} */
  let knex;
  /** @type {RunRepository} */
  let repo;
  const scope = { orgId: ORG, userId: USER };

  beforeEach(() => {
    knex = createAuthorityFake();
    repo = new RunRepository(knex, { now: () => FIXED_NOW });
  });

  it('resolveRunListLimit validates bounds', () => {
    assert.equal(resolveRunListLimit(undefined), 50);
    assert.equal(resolveRunListLimit(10), 10);
    assert.throws(() => resolveRunListLimit(0), /limit/);
    assert.throws(() => resolveRunListLimit(RUN_LIST_MAX_LIMIT + 1), /limit/);
  });

  it('normalizeExpectedStatuses accepts string or array of plan statuses', () => {
    assert.deepEqual(normalizeExpectedStatuses('QUEUED'), ['QUEUED']);
    assert.deepEqual(normalizeExpectedStatuses(['STARTING', 'RUNNING']), [
      'STARTING',
      'RUNNING',
    ]);
    assert.throws(() => normalizeExpectedStatuses([]), /expectedStatus/);
    assert.throws(() => normalizeExpectedStatuses('completed'), /status/i);
  });

  it('listNonTerminal filters terminal statuses and owner scope', async () => {
    seedRun(knex, { run_id: RUN, status: 'RUNNING' });
    seedRun(knex, { run_id: RUN2, status: 'SUCCEEDED' });
    seedRun(knex, {
      run_id: '01K0G2PAV8FPMVC9QHJG7JPN5E',
      status: 'QUEUED',
      user_id: USER2,
    });
    const list = await repo.listNonTerminal(scope);
    assert.equal(list.length, 1);
    assert.equal(list[0].runId, RUN);
    assert.equal(list[0].status, 'RUNNING');
    // Recoverable alias
    const rec = await repo.listRecoverable(scope);
    assert.equal(rec.length, 1);
    for (const s of NON_TERMINAL_RUN_STATUSES) {
      assert.ok(typeof s === 'string');
    }
  });

  it('updateStatusIf CAS: succeeds when expected matches', async () => {
    seedRun(knex, { status: 'QUEUED' });
    const updated = await repo.updateStatusIf(RUN, scope, {
      expectedStatus: 'QUEUED',
      status: 'STARTING',
    });
    assert.equal(updated.status, 'STARTING');
    assert.equal(knex.__tables.runs[0].status, 'STARTING');
  });

  it('updateStatusIf CAS: conflict when status differs', async () => {
    seedRun(knex, { status: 'RUNNING' });
    await assert.rejects(
      () =>
        repo.updateStatusIf(RUN, scope, {
          expectedStatuses: ['QUEUED', 'STARTING'],
          status: 'RUNNING',
        }),
      (err) => {
        assert.ok(err instanceof ConflictError);
        assert.match(String(err.message), /status conflict/i);
        return true;
      },
    );
    assert.equal(knex.__tables.runs[0].status, 'RUNNING');
  });

  it('updateStatusIf CAS: not found for other tenant', async () => {
    seedRun(knex, { status: 'QUEUED' });
    await assert.rejects(
      () =>
        repo.updateStatusIf(RUN, { orgId: ORG, userId: USER2 }, {
          expectedStatus: 'QUEUED',
          status: 'STARTING',
        }),
      NotFoundError,
    );
    assert.equal(knex.__tables.runs[0].status, 'QUEUED');
  });

  it('updateStatusIf applies whereIn for expected statuses (CAS SQL shape)', async () => {
    seedRun(knex, { status: 'STARTING' });
    // Multiple expected sources (STARTING | RUNNING → FAILED)
    const updated = await repo.updateStatusIf(RUN, scope, {
      expectedStatuses: ['STARTING', 'RUNNING', 'RETRYING'],
      status: 'FAILED',
      statusReason: 'boom',
    });
    assert.equal(updated.status, 'FAILED');
    assert.equal(updated.statusReason, 'boom');
  });

  it('preserves unconditional updateStatus API', async () => {
    seedRun(knex, { status: 'ACCEPTED' });
    const u = await repo.updateStatus(RUN, scope, { status: 'QUEUED' });
    assert.equal(u.status, 'QUEUED');
  });

  it('rejects invalid ULID / status / trace on create and filters', async () => {
    const bad26 = 'IIIIIIIIIIIIIIIIIIIIIIIIII'; // I excluded from Crockford
    await assert.rejects(
      () =>
        repo.create({
          runId: bad26,
          orgId: ORG,
          userId: USER,
          conversationId: CONV,
          agentSessionId: SESS,
          agentVersionId: VER,
          triggeringMessageId: MSG,
          source: 'web',
          status: 'ACCEPTED',
          queueName: 'runs',
          traceId: TRACE,
        }),
      /ULID/,
    );
    await assert.rejects(
      () =>
        repo.create({
          runId: RUN,
          orgId: ORG,
          userId: USER,
          conversationId: CONV,
          agentSessionId: SESS,
          agentVersionId: VER,
          triggeringMessageId: MSG,
          source: 'web',
          status: 'completed',
          queueName: 'runs',
          traceId: TRACE,
        }),
      /status/i,
    );
    await assert.rejects(
      () =>
        repo.create({
          runId: RUN,
          orgId: ORG,
          userId: USER,
          conversationId: CONV,
          agentSessionId: SESS,
          agentVersionId: VER,
          triggeringMessageId: MSG,
          source: 'web',
          status: 'ACCEPTED',
          queueName: 'runs',
          traceId: 'not-a-trace',
        }),
      /traceId/,
    );
    await assert.rejects(() => repo.getById(bad26, scope), /ULID/);
    await assert.rejects(
      () => repo.list(scope, { status: 'running' }),
      /status/i,
    );
  });
});

describe('ExternalReferenceRepository + user external subject', () => {
  /** @type {ReturnType<typeof createAuthorityFake>} */
  let knex;
  /** @type {ExternalReferenceRepository} */
  let refs;
  /** @type {OrganizationRepository} */
  let orgs;

  beforeEach(() => {
    knex = createAuthorityFake();
    refs = new ExternalReferenceRepository(knex, { now: () => FIXED_NOW });
    orgs = new OrganizationRepository(knex, { now: () => FIXED_NOW });
  });

  it('formatUserExternalSubject uses provider prefix', () => {
    assert.equal(formatUserExternalSubject('bff', 'uuid-1'), 'bff:uuid-1');
    assert.deepEqual(parseUserExternalSubject('bff:uuid-1'), {
      provider: 'bff',
      externalSubject: 'uuid-1',
    });
    assert.throws(() => formatUserExternalSubject('a:b', 'x'), /provider/);
  });

  it('organization external ref get/create with race handling', async () => {
    const created = await refs.createOrganizationRef({
      provider: 'bff',
      externalSubject: '550e8400-e29b-41d4-a716-446655440000',
      orgId: ORG,
    });
    assert.equal(created.orgId, ORG);
    assert.equal(isUlid(created.orgId), true);
    assert.equal(
      isLegacyOrUuidIdentity(created.externalSubject),
      true,
    );

    // Same mapping again (duplicate race path)
    const again = await refs.createOrganizationRef({
      provider: 'bff',
      externalSubject: '550e8400-e29b-41d4-a716-446655440000',
      orgId: ORG,
    });
    assert.equal(again.orgId, ORG);

    await assert.rejects(
      () =>
        refs.createOrganizationRef({
          provider: 'bff',
          externalSubject: '550e8400-e29b-41d4-a716-446655440000',
          orgId: '01K0G2PAV8FPMVC9QHJG7JPN5F',
        }),
      ConflictError,
    );
  });

  it('conversation external ref is owner-scoped (tenant isolation)', async () => {
    await refs.createConversationRef({
      orgId: ORG,
      userId: USER,
      provider: 'bff',
      externalSubject: 'conv-ext-1',
      conversationId: CONV,
    });
    const own = await refs.getConversationRef({
      orgId: ORG,
      userId: USER,
      provider: 'bff',
      externalSubject: 'conv-ext-1',
    });
    assert.equal(own?.conversationId, CONV);

    const foreign = await refs.getConversationRef({
      orgId: ORG,
      userId: USER2,
      provider: 'bff',
      externalSubject: 'conv-ext-1',
    });
    assert.equal(foreign, null);

    // Foreign user cannot steal mapping
    await refs.createConversationRef({
      orgId: ORG,
      userId: USER2,
      provider: 'bff',
      externalSubject: 'conv-ext-1',
      conversationId: '01K0G2PAV8FPMVC9QHJG7JPN5G',
    });
    const stillOwn = await refs.getConversationRef({
      orgId: ORG,
      userId: USER,
      provider: 'bff',
      externalSubject: 'conv-ext-1',
    });
    assert.equal(stillOwn?.conversationId, CONV);
  });

  it('getUserByExternalSubject + createUserIfAbsent race-safe', async () => {
    const subject = formatUserExternalSubject(
      'sandbox',
      'user-uuid-aaaa-bbbb-cccc-dddddddddddd',
    );
    const u = await orgs.createUserIfAbsent({
      userId: USER,
      externalSubject: subject,
      status: 'active',
    });
    assert.equal(u.userId, USER);
    const found = await orgs.getUserByExternalSubject(subject);
    assert.equal(found?.userId, USER);
    const byProvider = await orgs.getUserByProviderSubject(
      'sandbox',
      'user-uuid-aaaa-bbbb-cccc-dddddddddddd',
    );
    assert.equal(byProvider?.userId, USER);

    const again = await orgs.createUserIfAbsent({
      userId: USER,
      externalSubject: subject,
      status: 'active',
    });
    assert.equal(again.userId, USER);

    await assert.rejects(
      () =>
        orgs.createUserIfAbsent({
          userId: USER2,
          externalSubject: subject,
          status: 'active',
        }),
      ConflictError,
    );
  });

  it('never stores UUID in CHAR(26) org_id / conversation_id columns', async () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    await refs.createOrganizationRef({
      provider: 'bff',
      externalSubject: uuid,
      orgId: ORG,
    });
    const row = knex.__tables.organization_external_refs[0];
    assert.equal(row.org_id, ORG);
    assert.equal(isUlid(String(row.org_id)), true);
    assert.equal(isLegacyOrUuidIdentity(String(row.org_id)), false);
    assert.equal(String(row.external_subject), uuid);
  });

  it('rejects arbitrary 26-char non-ULID domain ids on write', async () => {
    const bad26 = 'IIIIIIIIIIIIIIIIIIIIIIIIII';
    await assert.rejects(
      () =>
        refs.createOrganizationRef({
          provider: 'bff',
          externalSubject: 'ext-1',
          orgId: bad26,
        }),
      /ULID/,
    );
    await assert.rejects(
      () =>
        refs.createConversationRef({
          orgId: ORG,
          userId: USER,
          provider: 'bff',
          externalSubject: 'ext-2',
          conversationId: bad26,
        }),
      /ULID/,
    );
    await assert.rejects(
      () =>
        orgs.createOrganization({
          orgId: bad26,
          name: 'x',
          status: 'active',
        }),
      /ULID/,
    );
    await assert.rejects(
      () =>
        orgs.createUser({
          userId: bad26,
          externalSubject: 'bff:x',
          status: 'active',
        }),
      /ULID/,
    );
    await assert.rejects(
      () =>
        orgs.addMembership({
          orgId: bad26,
          userId: USER,
          role: 'member',
          status: 'active',
        }),
      /ULID/,
    );
  });
});

describe('migration 20260718000003 static + up/down order', () => {
  const source = readFileSync(MIGRATION_PATH, 'utf8');

  it('is ordered after core and outbox migrations', () => {
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.js'))
      .sort();
    assert.ok(files.includes('20260718000001_core_platform_schema.js'));
    assert.ok(files.includes('20260718000002_outbox_delivery.js'));
    assert.ok(files.includes('20260718000003_run_authority_compatibility.js'));
    assert.ok(
      files.indexOf('20260718000003_run_authority_compatibility.js') >
        files.indexOf('20260718000002_outbox_delivery.js'),
    );
  });

  it('creates both mapping tables with InnoDB/utf8mb4 and CHAR(26) domain ids', () => {
    assert.match(
      source,
      /ORG_EXTERNAL_REFS_TABLE\s*=\s*['"]organization_external_refs['"]/,
    );
    assert.match(
      source,
      /CONV_EXTERNAL_REFS_TABLE\s*=\s*['"]conversation_external_refs['"]/,
    );
    assert.match(source, /createTable\(\s*ORG_EXTERNAL_REFS_TABLE\s*,/);
    assert.match(source, /createTable\(\s*CONV_EXTERNAL_REFS_TABLE\s*,/);
    assert.match(source, /t\.engine\(\s*['"]InnoDB['"]\s*\)/);
    assert.match(source, /t\.charset\(\s*['"]utf8mb4['"]\s*\)/);
    assert.match(source, /t\.collate\(\s*['"]utf8mb4_unicode_ci['"]\s*\)/);
    assert.match(source, /specificType\(\s*['"]org_id['"]\s*,\s*['"]CHAR\(26\)['"]\s*\)/);
    assert.match(
      source,
      /specificType\(\s*['"]conversation_id['"]\s*,\s*['"]CHAR\(26\)['"]\s*\)/,
    );
    // No UUID column type / data insert into CHAR(26)
    assert.doesNotMatch(source, /\.uuid\(/);
    assert.doesNotMatch(source, /\.insert\s*\(/);
    assert.doesNotMatch(source, /CHAR\(36\)/);
  });

  it('declares unique primary keys and FKs; reversible down drops child first', () => {
    assert.match(source, /pk_organization_external_refs/);
    assert.match(source, /pk_conversation_external_refs/);
    assert.match(source, /references\(\s*['"]organizations\.org_id['"]\s*\)/);
    assert.match(source, /references\(\s*['"]users\.user_id['"]\s*\)/);
    assert.match(
      source,
      /references\(\s*['"]conversations\.conversation_id['"]\s*\)/,
    );

    const downIdx = source.indexOf('export async function down');
    assert.ok(downIdx > 0);
    const downBody = source.slice(downIdx);
    const dropConv = downBody.indexOf('dropTableIfExists(CONV_EXTERNAL_REFS_TABLE)');
    const dropOrg = downBody.indexOf('dropTableIfExists(ORG_EXTERNAL_REFS_TABLE)');
    assert.ok(dropConv > 0, 'down must drop conversation_external_refs');
    assert.ok(dropOrg > dropConv, 'down must drop org refs after conversation refs');
  });

  it('exports up/down functions and exercises them against a stub schema', async () => {
    assert.equal(typeof migrationUp, 'function');
    assert.equal(typeof migrationDown, 'function');

    /** @type {string[]} */
    const created = [];
    /** @type {string[]} */
    const dropped = [];
    /** @type {string[]} */
    const raws = [];

    const stub = {
      raw: async (sql) => {
        raws.push(String(sql));
      },
      schema: {
        createTable: async (name, builder) => {
          created.push(name);
          // Minimal table builder stub
          const t = {
            engine() { return t; },
            charset() { return t; },
            collate() { return t; },
            string() { return t; },
            specificType() { return t; },
            primary() { return t; },
            index() { return t; },
            foreign() {
              return {
                references() {
                  return {
                    onDelete() {
                      return { onUpdate() { return t; } };
                    },
                    onUpdate() { return t; },
                  };
                },
              };
            },
            notNullable() { return t; },
          };
          builder(t);
        },
        dropTableIfExists: async (name) => {
          dropped.push(name);
        },
      },
    };

    await migrationUp(/** @type {any} */ (stub));
    assert.deepEqual(created, [
      ORG_EXTERNAL_REFS_TABLE,
      CONV_EXTERNAL_REFS_TABLE,
    ]);
    assert.ok(raws.some((s) => /utf8mb4/i.test(s)));

    await migrationDown(/** @type {any} */ (stub));
    assert.deepEqual(dropped, [
      CONV_EXTERNAL_REFS_TABLE,
      ORG_EXTERNAL_REFS_TABLE,
    ]);
  });
});

describe('repository index exports PR-04 symbols', () => {
  it('exports IdempotencyRepository and ExternalReferenceRepository', async () => {
    const mod = await import(
      '../../src/infrastructure/mysql/repositories/index.js'
    );
    assert.equal(typeof mod.IdempotencyRepository, 'function');
    assert.equal(typeof mod.ExternalReferenceRepository, 'function');
    assert.equal(typeof mod.RunRepository, 'function');
    assert.equal(typeof mod.formatUserExternalSubject, 'function');
  });
});
