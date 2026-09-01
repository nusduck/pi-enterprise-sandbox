import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DSH_SESSIONS_TABLE,
  DSH_SESSION_EVENTS_TABLE,
  up,
  down,
} from '../../src/infrastructure/mysql/migrations/20260901000002_dsh_session_persistence.js';

describe('native DSH session persistence migration', () => {
  it('creates owner-scoped header and event tables', () => {
    assert.equal(DSH_SESSIONS_TABLE, 'dsh_sessions');
    assert.equal(DSH_SESSION_EVENTS_TABLE, 'dsh_session_events');
    assert.equal(typeof up, 'function');
    assert.equal(typeof down, 'function');
    const source = readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../src/infrastructure/mysql/migrations/20260901000002_dsh_session_persistence.js',
      ),
      'utf8',
    );
    for (const name of [
      'session_id', 'org_id', 'user_id', 'header_json', 'revision',
      'seq', 'record_json', 'idx_dsh_sessions_owner',
      'idx_dsh_session_events_owner',
    ]) assert.match(source, new RegExp(name));
  });
});
