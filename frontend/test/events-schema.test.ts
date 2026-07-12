/**
 * Runtime event Zod schema tests.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  RuntimeEventSchema,
  parseRuntimeEvent,
  makeRuntimeEvent,
  RUNTIME_EVENT_TYPES,
  CreateRunResponseSchema,
} from '../src/shared/schemas/events.ts';

describe('RuntimeEventSchema', () => {
  it('accepts a full envelope', () => {
    const raw = {
      event_id: 'evt_1',
      sequence: 42,
      run_id: 'run_x',
      session_id: 'sess_1',
      type: 'tool.started',
      timestamp: '2026-07-12T00:00:00Z',
      payload: { tool_call_id: 'tc1', name: 'bash' },
    };
    const parsed = RuntimeEventSchema.safeParse(raw);
    assert.equal(parsed.success, true);
    if (parsed.success) {
      assert.equal(parsed.data.sequence, 42);
      assert.equal(parsed.data.type, 'tool.started');
    }
  });

  it('rejects missing event_id / sequence / run_id', () => {
    assert.equal(
      RuntimeEventSchema.safeParse({ type: 'run.started', sequence: 1 }).success,
      false,
    );
    assert.equal(parseRuntimeEvent({ type: 'x' }), null);
  });

  it('makeRuntimeEvent fills defaults', () => {
    const e = makeRuntimeEvent({
      event_id: 'e',
      sequence: 0,
      run_id: 'r',
      type: 'run.created',
    });
    assert.deepEqual(e.payload, {});
    assert.equal(e.session_id, null);
  });

  it('lists known ADR event types', () => {
    assert.ok(RUNTIME_EVENT_TYPES.includes('run.created'));
    assert.ok(RUNTIME_EVENT_TYPES.includes('process.stdout'));
    assert.ok(RUNTIME_EVENT_TYPES.includes('budget.exceeded'));
  });

  it('parses create-run response', () => {
    const r = CreateRunResponseSchema.safeParse({
      run_id: 'run_1',
      status: 'queued',
    });
    assert.equal(r.success, true);
  });
});
