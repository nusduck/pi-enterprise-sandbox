/**
 * Probe scoping for orchestrated deployments.
 *
 * Readiness controls Service endpoint membership, so it must answer a question
 * only this replica can answer. Fanning out to Agent and Sandbox would couple
 * every replica's readiness to a shared dependency: one upstream blip would
 * empty the endpoint list, turning partial degradation into a full outage while
 * removing the capacity that would have absorbed it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  beginDraining,
  handleLiveness,
  handleReadiness,
  isAcceptingTraffic,
} from '../src/routes/status.js';

/** Captures what a handler wrote, without a socket. */
function fakeRes() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers || {};
      return this;
    },
    setHeader(key, value) {
      this.headers[key] = value;
    },
    end(payload) {
      this.body = payload ? JSON.parse(payload) : null;
    },
  };
}

// Draining is deliberately one-way — a replica told to shut down never returns
// to service — so these run in order: serving first, then draining.
describe('readiness is self-scoped', () => {
  it('reports ready without consulting Agent or Sandbox', () => {
    const res = fakeRes();
    handleReadiness(res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'ok');
    // No upstream keys: this endpoint makes no claim about dependencies.
    assert.equal(res.body.agent, undefined);
    assert.equal(res.body.sandbox, undefined);
  });

  it('liveness never depends on anything external', () => {
    const res = fakeRes();
    handleLiveness(res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'ok');
  });

  it('reports 503 once draining, so the replica leaves rotation first', () => {
    beginDraining();

    const res = fakeRes();
    handleReadiness(res);

    assert.equal(res.statusCode, 503);
    assert.equal(res.body.status, 'draining');
    assert.equal(isAcceptingTraffic(), false);
  });

  it('liveness stays 200 while draining', () => {
    // Failing liveness would make the orchestrator kill the pod mid-drain,
    // cutting the requests the drain exists to finish.
    const res = fakeRes();
    handleLiveness(res);

    assert.equal(res.statusCode, 200);
  });
});
