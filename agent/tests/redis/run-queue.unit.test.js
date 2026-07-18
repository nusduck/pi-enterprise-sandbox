/**
 * BullMQ factory unit tests without installing bullmq/ioredis.
 * Uses module-level contracts + stub injection via assertRunJobRef / naming.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_RUNS_QUEUE_NAME,
  assertRunJobRef,
  assertRedisConnectionUrl,
  RedisConfigError,
  RedisValidationError,
} from '../../src/infrastructure/redis/index.js';

const RUN = '01K0G2PAV8FPMVC9QHJG7JPN53';
const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const TRACE = 'b'.repeat(32);

describe('run-queue factories (lazy deps, pure contracts)', () => {
  it('exports agent-runs as logical queue name', () => {
    assert.equal(AGENT_RUNS_QUEUE_NAME, 'agent-runs');
  });

  it('queue connection URL gate rejects empty and empty-host before any bullmq import', () => {
    assert.throws(() => assertRedisConnectionUrl(''), RedisConfigError);
    assert.throws(() => assertRedisConnectionUrl(null), RedisConfigError);
    assert.throws(() => assertRedisConnectionUrl('redis://'), RedisConfigError);
    assert.throws(() => assertRedisConnectionUrl('redis://:password@'), RedisConfigError);
  });

  it('processor contract: only refs pass assertRunJobRef', () => {
    const good = { runId: RUN, orgId: ORG, traceId: TRACE };
    assert.deepEqual(assertRunJobRef(good), good);

    /** Simulates Worker wrapping job.data */
    function wrapProcessor(processor) {
      return async (job) => {
        const ref = assertRunJobRef(job.data);
        return processor(ref, job);
      };
    }

    let seen = null;
    const proc = wrapProcessor(async (ref) => {
      seen = ref;
      return 'ok';
    });

    return proc({ data: good, id: RUN }).then((r) => {
      assert.equal(r, 'ok');
      assert.deepEqual(seen, good);
    });
  });

  it('processor rejects fat job payloads and invalid IDs before MySQL load', async () => {
    function wrapProcessor(processor) {
      return async (job) => {
        const ref = assertRunJobRef(job.data);
        return processor(ref, job);
      };
    }
    const proc = wrapProcessor(async () => {
      throw new Error('should not reach processor');
    });
    await assert.rejects(
      () =>
        proc({
          data: {
            runId: RUN,
            orgId: ORG,
            traceId: TRACE,
            fullTranscript: '…',
          },
        }),
      RedisValidationError,
    );
    await assert.rejects(
      () =>
        proc({
          data: {
            runId: 'not-a-ulid',
            orgId: ORG,
            traceId: TRACE,
          },
        }),
      RedisValidationError,
    );
  });

  it('deterministic jobId equals runId for enqueue options', () => {
    const ref = assertRunJobRef({ runId: RUN, orgId: ORG, traceId: TRACE });
    const jobOptions = { jobId: ref.runId };
    assert.equal(jobOptions.jobId, RUN);
  });
});
