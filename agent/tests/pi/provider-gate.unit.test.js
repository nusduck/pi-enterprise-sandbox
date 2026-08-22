/**
 * Process-global provider gate.
 *
 * The regressions pinned here are the ones that made the first version inert:
 * a Set keyed by provider name (so N concurrent calls to one provider counted
 * as one), and a degrade path that handed back a real release closure for a
 * slot it never got.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createProviderGate,
  getProcessProviderGate,
  resetProcessProviderGate,
} from '../../src/infrastructure/provider-gate.js';

/** Resolve after the current macrotask queue drains. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('provider gate', () => {
  it('counts concurrent calls to the SAME provider against the cap', async () => {
    const gate = createProviderGate({ maxConcurrent: 2, maxWaitMs: 5_000 });

    const first = await gate.acquire('deepseek-v4-flash');
    const second = await gate.acquire('deepseek-v4-flash');
    assert.equal(gate.snapshot().inFlight, 2);

    // Third call to the same provider must WAIT, not collapse into one entry.
    let thirdGranted = false;
    const third = gate.acquire('deepseek-v4-flash').then((release) => {
      thirdGranted = true;
      return release;
    });
    await tick();
    assert.equal(thirdGranted, false, 'cap must engage for one provider key');
    assert.equal(gate.snapshot().waiting, 1);

    first();
    const release = await third;
    assert.equal(thirdGranted, true);
    assert.equal(gate.snapshot().inFlight, 2, 'release hands the slot over');

    second();
    release();
    assert.equal(gate.snapshot().inFlight, 0);
  });

  it('degrades to a no-op release when the bounded wait expires', async () => {
    const gate = createProviderGate({ maxConcurrent: 1, maxWaitMs: 1 });
    const held = await gate.acquire('p');
    assert.equal(gate.snapshot().inFlight, 1);

    const degraded = await gate.acquire('p');
    assert.equal(gate.snapshot().inFlight, 1, 'timed-out caller holds no slot');

    // Calling the degraded release must not free the slot someone else owns.
    degraded();
    degraded();
    assert.equal(gate.snapshot().inFlight, 1);

    held();
    assert.equal(gate.snapshot().inFlight, 0);
  });

  it('never releases twice from one grant', async () => {
    const gate = createProviderGate({ maxConcurrent: 2 });
    const a = await gate.acquire('p');
    await gate.acquire('p');
    assert.equal(gate.snapshot().inFlight, 2);
    a();
    a();
    a();
    assert.equal(gate.snapshot().inFlight, 1);
  });

  it('does not grant a slot to an already-aborted caller', async () => {
    const gate = createProviderGate({ maxConcurrent: 1, maxWaitMs: 5_000 });
    const held = await gate.acquire('p');
    const controller = new AbortController();
    controller.abort();
    const release = await gate.acquire('p', controller.signal);
    assert.equal(gate.snapshot().inFlight, 1);
    release();
    assert.equal(gate.snapshot().inFlight, 1);
    held();
    assert.equal(gate.snapshot().inFlight, 0);
  });

  it('escalates the 429 cooldown per provider and clears it on recovery', async () => {
    const gate = createProviderGate({ cooldownMs: 10, maxCooldownMs: 40 });
    assert.equal(gate.snapshot().cooldownKeys, 0);

    gate.observe('p', 429);
    gate.observe('p', 429);
    assert.equal(gate.snapshot().cooldownKeys, 1);
    // A recovered provider must not stay throttled for the process lifetime.
    gate.observe('p', 200);
    assert.equal(gate.snapshot().cooldownKeys, 0);

    // Cooldown is per key: one rate-limited model does not gate the others.
    gate.observe('a', 429);
    assert.equal(gate.snapshot().cooldownKeys, 1);
    gate.observe('b', 500);
    assert.equal(gate.snapshot().cooldownKeys, 1);
  });

  it('waits out a live cooldown before taking a slot', async () => {
    const gate = createProviderGate({ maxConcurrent: 4, cooldownMs: 40 });
    gate.observe('p', 429);
    const started = Date.now();
    const release = await gate.acquire('p');
    assert.ok(
      Date.now() - started >= 20,
      'a 429-cooled provider must not be re-hit immediately',
    );
    release();
  });

  it('shares ONE gate across every Run in this process', () => {
    resetProcessProviderGate();
    const first = getProcessProviderGate({ maxConcurrent: 3 });
    const second = getProcessProviderGate({ maxConcurrent: 99 });
    assert.equal(first, second, 'per-Run gates would never throttle anything');
    assert.equal(second.snapshot().maxConcurrent, 3);
    resetProcessProviderGate();
    assert.notEqual(getProcessProviderGate(), first);
    resetProcessProviderGate();
  });
});
