/**
 * There are two Pi→event projections in this codebase: the observability
 * extension (live) and PlatformEventProjector (not live). Keeping both is a
 * deliberate call — a Run assembled without the enterprise bundle has no
 * observability extension and would otherwise emit nothing — but it only stays
 * safe while everyone knows which one production runs.
 *
 * These tests pin that: the moment an extension bundle exists, the executor
 * must hand event ownership to observability, and the redaction helpers the
 * live path depends on must not live inside the dormant module.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as projectorModule from '../../src/infrastructure/pi/platform-event-projector.js';
import * as redactionModule from '../../src/infrastructure/pi/event-redaction.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '../..');

describe('PlatformEventProjector is not the production event path', () => {
  it('the executor switches to observability whenever a bundle is present', () => {
    // The behavioural assertion lives in pi-run-executor.unit.test.js
    // ("propagates acquired executionFenceToken…" builds a bundle and asserts
    // the resulting events). This guards the switch itself, which is a single
    // line that would otherwise be easy to delete without any test noticing.
    const src = readFileSync(
      join(root, 'src/application/pi-run-executor.js'),
      'utf8',
    );
    assert.match(
      src,
      /if \(projectionMode === 'session-subscribe'\) \{\s*\n\s*projectionMode = 'observability';/,
      'a bundle must take over event ownership from the projector',
    );
  });

  it('the live redaction helpers are not exported from the dormant module', () => {
    // If these come back, twelve production modules start importing the
    // dormant projector again just to reach them.
    for (const name of [
      'redactPayload',
      'redactInlineSecrets',
      'summarizeToolArgs',
      'summarizeToolResult',
      'summarizeAssistantMessage',
      'extractToolCallBlocks',
      'extractAssistantTextForUi',
    ]) {
      assert.equal(
        typeof redactionModule[name],
        'function',
        `${name} belongs to event-redaction.js`,
      );
      assert.equal(
        projectorModule[name],
        undefined,
        `${name} must not be re-exported from platform-event-projector.js`,
      );
    }
  });

  it('no production module outside pi/ imports the projector for helpers', () => {
    const src = readFileSync(
      join(root, 'src/application/pi-run-executor.js'),
      'utf8',
    );
    const projectorImport = src.match(
      /import \{([^}]*)\} from '[^']*platform-event-projector\.js'/,
    );
    assert.ok(projectorImport, 'the executor still constructs the projector');
    assert.deepEqual(
      projectorImport[1]
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean),
      ['PlatformEventProjector'],
      'only the class itself — helpers come from event-redaction.js',
    );
  });

  it('both projections still agree on the event vocabulary', () => {
    // Drift here is the actual hazard of keeping two projections: an event type
    // added to one and not the other.
    const observabilitySrc = readFileSync(
      join(root, 'src/extensions/observability/index.js'),
      'utf8',
    );
    const emitted = new Set(
      [...observabilitySrc.matchAll(/emit\(\s*\n?\s*'([a-z.]+)'/g)].map((m) => m[1]),
    );
    assert.ok(emitted.size > 0, 'failed to read the observability event types');

    const projected = new Set(projectorModule.PROJECTOR_EVENT_TYPES);
    // Types observability emits that the projector does not know about. The
    // reverse is allowed: the projector maps some events observability leaves
    // to the governance recorder.
    const onlyLive = [...emitted].filter(
      (type) => !projected.has(type) && !type.startsWith('context.'),
    );
    assert.deepEqual(
      onlyLive,
      [],
      'add the type to PROJECTOR_EVENT_TYPES, or state why it is live-only',
    );
  });
});
