/**
 * SubagentSpawnService — durable child Runs.
 * Offline fakes only — no MySQL/Redis/Docker/network.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { CreateRunService } from '../../src/application/create-run-service.js';
import {
  SubagentLimitError,
  SubagentSpawnService,
  SUBAGENT_RUN_SOURCE,
} from '../../src/application/subagent-spawn-service.js';
import { OwnerScopedNotFoundError } from '../../src/application/errors.js';
import { RUN_STATUS } from '../../src/domain/run/run-status.js';
import { isUlid } from '../../src/domain/shared/ulid.js';
import {
  createFakeRunWorld,
  FIXED_AUTH,
  TRACE,
} from './helpers/fake-run-world.js';

const NOW = () => new Date('2026-08-22T06:00:00.000Z');
const MESSAGES = [{ role: 'user', content: [{ type: 'text', text: 'plan it' }] }];

/**
 * @param {ReturnType<typeof createFakeRunWorld>} world
 * @param {object} [opts]
 */
function buildSpawn(world, opts = {}) {
  return new SubagentSpawnService({
    transactionManager: world.transactionManager,
    createRepositories: world.createRepositories,
    generateId: world.generateId,
    now: NOW,
    runQueue: world.runQueue,
    ...opts,
  });
}

/**
 * Create a parent Run through the ordinary create path, then read it back.
 * @param {ReturnType<typeof createFakeRunWorld>} world
 */
async function createParentRun(world, idempotencyKey = 'parent-1') {
  const create = new CreateRunService({
    transactionManager: world.transactionManager,
    createRepositories: world.createRepositories,
    generateId: world.generateId,
    now: NOW,
    runQueue: world.runQueue,
  });
  const created = await create.execute({
    messages: MESSAGES,
    auth: FIXED_AUTH,
    traceId: TRACE,
    idempotencyKey,
  });
  const row = world.tables.runs.find((r) => r.run_id === created.runId);
  return {
    runId: created.runId,
    orgId: String(row.org_id),
    userId: String(row.user_id),
    conversationId: String(row.conversation_id),
    agentSessionId: String(row.agent_session_id),
    agentVersionId: String(row.agent_version_id),
  };
}

/** @param {ReturnType<typeof createFakeRunWorld>} world */
function childRows(world, parentRunId) {
  return world.tables.runs.filter((r) => r.parent_run_id === parentRunId);
}

describe('SubagentSpawnService.spawn', () => {
  /** @type {ReturnType<typeof createFakeRunWorld>} */
  let world;
  beforeEach(() => {
    world = createFakeRunWorld();
  });

  it('creates a queued child Run with durable lineage', async () => {
    const parent = await createParentRun(world);
    const service = buildSpawn(world);

    const result = await service.spawn({
      toolCallId: 'call-1',
      parentRunId: parent.runId,
      orgId: parent.orgId,
      userId: parent.userId,
      task: 'summarize docs/plan.md',
      label: 'summary',
    });

    assert.equal(result.replayed, false);
    assert.equal(result.queueWarning, null);
    assert.ok(isUlid(result.runId));

    const children = childRows(world, parent.runId);
    assert.equal(children.length, 1);
    const child = children[0];
    assert.equal(child.run_id, result.runId);
    assert.equal(child.source, SUBAGENT_RUN_SOURCE);
    assert.equal(child.subagent_depth, 1);
    assert.equal(child.subagent_label, 'summary');
    assert.equal(child.status, RUN_STATUS.QUEUED, 'child must reach the queue');
    // One trace for the whole fan-out, parented to the parent run span.
    assert.equal(child.trace_id, TRACE);
    assert.match(String(child.trace_parent_span_id), /^[0-9a-f]{16}$/);
    // Enqueued after commit, exactly once.
    assert.deepEqual(
      world.enqueuedJobs.filter((job) => job.runId === result.runId).length,
      1,
    );
  });

  it('gives the child its own conversation and AgentSession', async () => {
    const parent = await createParentRun(world);
    const result = await buildSpawn(world).spawn({
      toolCallId: 'call-1',
      parentRunId: parent.runId,
      orgId: parent.orgId,
      userId: parent.userId,
      task: 'independent work',
    });

    const child = childRows(world, parent.runId)[0];
    // Sharing the parent's session would deadlock: the parent holds its
    // execution fence for its whole life.
    assert.notEqual(child.agent_session_id, parent.agentSessionId);
    assert.notEqual(child.conversation_id, parent.conversationId);
    // Same owner and same agent configuration.
    assert.equal(child.org_id, parent.orgId);
    assert.equal(child.user_id, parent.userId);
    assert.equal(child.agent_version_id, parent.agentVersionId);

    const session = world.tables.agent_sessions.find(
      (s) => s.agent_session_id === child.agent_session_id,
    );
    assert.equal(session.status, 'ACTIVE');
    assert.notEqual(session.sandbox_session_id, null);
    assert.notEqual(session.workspace_id, null);

    // The task is the child's triggering user message.
    const message = world.tables.messages.find(
      (m) => m.message_id === child.triggering_message_id,
    );
    assert.equal(message.role, 'user');
    assert.equal(JSON.parse(message.content_json).text, 'independent work');
    assert.equal(
      JSON.parse(message.content_json).subagent.parentRunId,
      parent.runId,
    );
    assert.equal(result.runId, child.run_id);
  });

  it('adopts the existing child when the same tool call retries', async () => {
    const parent = await createParentRun(world);
    const service = buildSpawn(world);
    const input = {
      toolCallId: 'call-retry',
      parentRunId: parent.runId,
      orgId: parent.orgId,
      userId: parent.userId,
      task: 'exactly once',
    };

    const first = await service.spawn(input);
    const second = await service.spawn(input);

    assert.equal(second.runId, first.runId);
    assert.equal(second.replayed, true);
    assert.equal(childRows(world, parent.runId).length, 1);
  });

  it('caps live siblings and lets a finished one free a slot', async () => {
    const parent = await createParentRun(world);
    const service = buildSpawn(world, { maxConcurrent: 2 });
    const base = {
      parentRunId: parent.runId,
      orgId: parent.orgId,
      userId: parent.userId,
    };

    const a = await service.spawn({ ...base, toolCallId: 'c1', task: 'a' });
    await service.spawn({ ...base, toolCallId: 'c2', task: 'b' });

    await assert.rejects(
      () => service.spawn({ ...base, toolCallId: 'c3', task: 'c' }),
      (error) => {
        assert.ok(error instanceof SubagentLimitError);
        assert.equal(error.code, 'SUBAGENT_CONCURRENCY_LIMIT');
        return true;
      },
    );

    // Terminal children do not hold a slot.
    world.tables.runs.find((r) => r.run_id === a.runId).status =
      RUN_STATUS.SUCCEEDED;
    const third = await service.spawn({ ...base, toolCallId: 'c4', task: 'c' });
    assert.ok(isUlid(third.runId));
  });

  it('refuses to spawn past the depth cap', async () => {
    const parent = await createParentRun(world);
    const service = buildSpawn(world, { maxDepth: 1 });
    const base = {
      parentRunId: parent.runId,
      orgId: parent.orgId,
      userId: parent.userId,
    };

    const child = await service.spawn({ ...base, toolCallId: 'c1', task: 'a' });
    await assert.rejects(
      () =>
        service.spawn({
          ...base,
          parentRunId: child.runId,
          toolCallId: 'c2',
          task: 'grandchild',
        }),
      (error) => {
        assert.equal(error.code, 'SUBAGENT_DEPTH_LIMIT');
        return true;
      },
    );
    assert.equal(childRows(world, child.runId).length, 0);
  });

  it('never crosses the owner scope', async () => {
    const parent = await createParentRun(world);
    await assert.rejects(
      () =>
        buildSpawn(world).spawn({
          toolCallId: 'c1',
          parentRunId: parent.runId,
          orgId: parent.orgId,
          userId: '01K0G2PAV8FPMVC9QHJG7JPZZZ',
          task: 'steal',
        }),
      OwnerScopedNotFoundError,
    );
    assert.equal(childRows(world, parent.runId).length, 0);
  });

  it('keeps the committed child when the queue is down', async () => {
    const parent = await createParentRun(world);
    world.runQueue.setFail(true);
    const result = await buildSpawn(world).spawn({
      toolCallId: 'c1',
      parentRunId: parent.runId,
      orgId: parent.orgId,
      userId: parent.userId,
      task: 'durable anyway',
    });
    assert.equal(result.queueWarning, 'QUEUE_ENQUEUE_FAILED');
    const child = childRows(world, parent.runId)[0];
    assert.equal(child.status, RUN_STATUS.ACCEPTED, 'recovery re-enqueues it');
  });
});

describe('SubagentSpawnService.getStatuses', () => {
  /** @type {ReturnType<typeof createFakeRunWorld>} */
  let world;
  beforeEach(() => {
    world = createFakeRunWorld();
  });

  it('reports children and the answer of the terminal ones', async () => {
    const parent = await createParentRun(world);
    const service = buildSpawn(world);
    const base = {
      parentRunId: parent.runId,
      orgId: parent.orgId,
      userId: parent.userId,
    };
    const done = await service.spawn({
      ...base,
      toolCallId: 'c1',
      task: 'finished',
      label: 'first',
    });
    const running = await service.spawn({
      ...base,
      toolCallId: 'c2',
      task: 'still going',
    });

    // The finished child wrote an assistant transcript row, like any Run.
    const doneRow = world.tables.runs.find((r) => r.run_id === done.runId);
    doneRow.status = RUN_STATUS.SUCCEEDED;
    await world.transactionManager.run(async (trx) => {
      const repos = world.createRepositories(trx);
      await repos.messages.append({
        messageId: world.generateId(),
        conversationId: doneRow.conversation_id,
        orgId: parent.orgId,
        userId: parent.userId,
        agentSessionId: doneRow.agent_session_id,
        runId: done.runId,
        role: 'assistant',
        messageType: 'text',
        contentJson: { kind: 'assistant_message', text: 'the answer is 42' },
      });
    });

    const statuses = await service.getStatuses({
      parentRunId: parent.runId,
      orgId: parent.orgId,
      userId: parent.userId,
    });
    assert.equal(statuses.length, 2);

    const finished = statuses.find((s) => s.runId === done.runId);
    assert.equal(finished.status, RUN_STATUS.SUCCEEDED);
    assert.equal(finished.label, 'first');
    assert.equal(finished.resultSummary, 'the answer is 42');

    const pending = statuses.find((s) => s.runId === running.runId);
    assert.equal(pending.status, RUN_STATUS.QUEUED);
    assert.equal(
      'resultSummary' in pending,
      false,
      'an unfinished child has no answer to report',
    );
  });

  it('narrows to the named children and ignores foreign ids', async () => {
    const parentA = await createParentRun(world, 'parent-a');
    const parentB = await createParentRun(world, 'parent-b');
    const service = buildSpawn(world);
    const childA = await service.spawn({
      toolCallId: 'c1',
      parentRunId: parentA.runId,
      orgId: parentA.orgId,
      userId: parentA.userId,
      task: 'a',
    });
    const childB = await service.spawn({
      toolCallId: 'c2',
      parentRunId: parentB.runId,
      orgId: parentB.orgId,
      userId: parentB.userId,
      task: 'b',
    });

    const statuses = await service.getStatuses({
      parentRunId: parentA.runId,
      orgId: parentA.orgId,
      userId: parentA.userId,
      childRunIds: [childA.runId, childB.runId],
    });
    assert.deepEqual(
      statuses.map((s) => s.runId),
      [childA.runId],
      'another parent’s child must not leak into this poll',
    );
  });
});
