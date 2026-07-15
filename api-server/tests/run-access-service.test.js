import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DURABLE_RUN_READ_RETRY_DELAYS_MS,
  getDurableRun,
} from '../application/run-access-service.js';

test('durable run read defense-in-depth retry is capped at 20ms', () => {
  assert.equal(
    DURABLE_RUN_READ_RETRY_DELAYS_MS.reduce((total, delay) => total + delay, 0),
    20,
  );
});

test('durable run reads retry a committed-write 404 once', async () => {
  let reads = 0;
  const run = { run_id: 'arun_ready', conversation_id: 'conv_1' };
  const sandbox = {
    async getAgentRun() {
      reads += 1;
      if (reads === 1) {
        const error = new Error('not visible yet');
        error.status = 404;
        throw error;
      }
      return run;
    },
  };

  assert.deepEqual(await getDurableRun(sandbox, run.run_id), run);
  assert.equal(reads, 2);
});

test('unknown or foreign run reads remain 404 after bounded retries', async () => {
  let reads = 0;
  const sandbox = {
    async getAgentRun() {
      reads += 1;
      const error = new Error('not found');
      error.status = 404;
      throw error;
    },
  };

  await assert.rejects(
    getDurableRun(sandbox, 'arun_unknown'),
    (error) => error?.status === 404,
  );
  assert.equal(reads, 3);
});
