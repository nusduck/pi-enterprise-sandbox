/**
 * The durable snapshot codec's copy of Pi's session format must stay honest.
 *
 * `pi-jsonl-codec.js` hardcodes `PI_SESSION_JSONL_VERSION = 3` and a nine-entry
 * type table, transcribed from the SDK. Those constants stay ours on purpose —
 * a snapshot already written to MySQL is a persistence contract and must not
 * silently re-interpret itself when the SDK moves. What must not happen is
 * drifting without anyone noticing: `SessionManager.open` skips lines it cannot
 * parse rather than failing, so a v4 SDK would leave the codec validating v4
 * snapshots against v3 rules and rejecting the new entries as malformed.
 *
 * These tests fail on the upgrade, which is the whole point: the fix is a
 * deliberate migration, not a constant bump.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CURRENT_SESSION_VERSION,
  parseSessionEntries,
} from '@earendil-works/pi-coding-agent';
import {
  PI_JSONL_ENTRY_TYPES,
  PI_SESSION_JSONL_VERSION,
  buildSessionHeader,
  materializeJsonl,
  validateSnapshotPayload,
} from '../../src/infrastructure/pi/pi-jsonl-codec.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sessionManagerDts = join(
  __dirname,
  '../../node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts',
);

/**
 * The `type` literals of every member of the SDK's `SessionEntry` union.
 *
 * Read from the shipped declarations because the union is erased at runtime:
 * `parseSessionEntries` is a plain JSON.parse loop and validates no types at
 * all, so there is nothing to introspect from the runtime exports.
 *
 * @returns {string[]}
 */
function sdkSessionEntryTypes() {
  const source = readFileSync(sessionManagerDts, 'utf8');

  const unionMatch = source.match(/export type SessionEntry\s*=\s*([^;]+);/);
  assert.ok(unionMatch, 'SessionEntry union not found — SDK layout changed');
  const memberNames = unionMatch[1]
    .split('|')
    .map((name) => name.trim())
    .filter(Boolean);
  assert.ok(memberNames.length > 0, 'SessionEntry union parsed as empty');

  return memberNames.map((name) => {
    const body = source.match(
      new RegExp(`export interface ${name}\\b[^{]*\\{([\\s\\S]*?)\\n\\}`),
    );
    assert.ok(body, `interface ${name} not found in session-manager.d.ts`);
    const literal = body[1].match(/\btype:\s*"([a-z_]+)"/);
    assert.ok(literal, `interface ${name} has no literal type field`);
    return literal[1];
  });
}

describe('Pi session JSONL contract', () => {
  it('the codec version still matches the SDK session version', () => {
    assert.equal(
      PI_SESSION_JSONL_VERSION,
      CURRENT_SESSION_VERSION,
      'Snapshots on disk are written at PI_SESSION_JSONL_VERSION. When the SDK ' +
        'moves, migrate existing snapshots deliberately — do not just bump this.',
    );
  });

  it('the codec entry-type table still matches the SDK SessionEntry union', () => {
    assert.deepEqual(
      [...PI_JSONL_ENTRY_TYPES].sort(),
      sdkSessionEntryTypes().sort(),
      'An SDK entry type the codec does not list is rejected as a malformed ' +
        'line, so a session using it cannot be recovered.',
    );
  });

  it('the header type the codec writes is the one the SDK reads', () => {
    const dts = readFileSync(sessionManagerDts, 'utf8');
    const header = dts.match(/export interface SessionHeader\b[^{]*\{([\s\S]*?)\n\}/);
    assert.ok(header, 'SessionHeader not found');
    assert.match(header[1], /\btype:\s*"session"/);

    const built = buildSessionHeader({ id: 'sess-1', cwd: '/workspace' });
    assert.equal(built.type, 'session');
    assert.equal(built.version, CURRENT_SESSION_VERSION);
  });

  it('materialized JSONL round-trips through the SDK parser', () => {
    // Guards the direction the codec is actually used in: everything it writes
    // must survive SessionManager.open, which parses with parseSessionEntries.
    const payload = validateSnapshotPayload({
      header: buildSessionHeader({ id: 'sess-1', cwd: '/workspace' }),
      entries: [
        {
          type: 'message',
          id: 'e1',
          parentId: null,
          timestamp: '2026-07-18T00:00:00.000Z',
          message: { role: 'user', content: 'hi' },
        },
      ],
    });

    const parsed = parseSessionEntries(materializeJsonl(payload));
    assert.equal(parsed.length, 2, 'header plus one entry');
    assert.equal(parsed[0].type, 'session');
    assert.equal(parsed[0].version, PI_SESSION_JSONL_VERSION);
    assert.equal(parsed[1].type, 'message');
    assert.equal(parsed[1].id, 'e1');
  });
});
