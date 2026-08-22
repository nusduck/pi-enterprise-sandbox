/**
 * Cancelling a parent Run stops its sub-agent children.
 *
 * The cascade deliberately writes only the durable cancel intent (plus the
 * Redis signal as acceleration): a child then stops itself through the same
 * path any cancelled Run takes, because execute-run-service checks the intent
 * before entering the runtime and again around each step.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { CreateRunService } from '../../src/application/create-run-service.js';
import { CancelRunService } from '../../src/application/cancel-run-service.js';
import { SubagentSpawnService } from '../../src/application/subagent-spawn-service.js';
import { RUN_STATUS } from '../../src/domain/run/run-status.js';
import {
  createFakeRunWorld,
  FIXED_AUTH,
  TRACE,
} from './helpers/fake-run-world.js';

const NOW = () => new Date('2026-08-22T06:00:00.000Z');
const MESSAGES = [{ role: 'user', content: [{ type: 'text', text: 'plan it' }] }];

/** @param {ReturnType<typeof createFakeRunWorld>} world */
function services(world, spawnOpts = {}) {
  const common = {
    transactionManager: world.transactionManager,
    createRepositories: world.createRepositories,
    generateId: world.generateId,
    now: NOW,
  };
  return {
    create: new CreateRunService({ ...common, runQueue: world.runQueue }),
    cancel: new CancelRunService({ ...common, cancelSignal: world.cancelSignal }),
    spawn: new SubagentSpawnService({
      ...common,
      runQueue: world.runQueue,
      ...spawnOpts,
    }),
  };
}

/** @param {ReturnType<typeof createFakeRunWorld>} world */
async function parentRun(world, create, idempotencyKey = 'parent-1') {
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
  };
}

/** @param {ReturnType<typeof createFakeRunWorld>} world */
function runRow(world, runId) {
  return world.tables.runs.find((r) => r.run_id === runId);
}

describe('cancel cascades to sub-agent children', () => {
  /** @type {ReturnType<typeof createFakeRunWorld>} */
  let world;
  beforeEach(() => {
    world = createFakeRunWorld();
  });

  it('sets durable cancel intent on every live descendant', async () => {
    const { create, cancel, spawn } = services(world);
    const parent = await parentRun(world, create);
    const base = {
      parentRunId: parent.runId,
      orgId: parent.orgId,
      userId: parent.userId,
    };
    const childA = await spawn.spawn({ ...base, toolCallId: 'c1', task: 'a' });
    const childB = await spawn.spawn({ ...base, toolCallId: 'c2', task: 'b' });
    // A grandchild: the walk must reach past the first level.
    const grandchild = await spawn.spawn({
      ...base,
      parentRunId: childA.runId,
      toolCallId: 'c3',
      task: 'deep',
    });

    const result = await cancel.execute({
      runId: parent.runId,
      auth: FIXED_AUTH,
      reason: 'user changed their mind',
    });

    assert.deepEqual(
      [...result.cancelledDescendants].sort(),
      [childA.runId, childB.runId, grandchild.runId].sort(),
    );
    for (const id of result.cancelledDescendants) {
      assert.ok(
        runRow(world, id).cancel_requested_at,
        `${id} must carry durable cancel intent, not just a Redis signal`,
      );
    }
    // Redis signal for the parent and for each child.
    const signalled = world.cancelSignals.map((s) => s.runId);
    for (const id of [parent.runId, childA.runId, childB.runId, grandchild.runId]) {
      assert.ok(signalled.includes(id), `no cancel signal for ${id}`);
    }
  });

  it('leaves terminal children and other parents alone', async () => {
    const { create, cancel, spawn } = services(world);
    const parentA = await parentRun(world, create, 'parent-a');
    const parentB = await parentRun(world, create, 'parent-b');
    const mine = await spawn.spawn({
      parentRunId: parentA.runId,
      orgId: parentA.orgId,
      userId: parentA.userId,
      toolCallId: 'c1',
      task: 'live',
    });
    const finished = await spawn.spawn({
      parentRunId: parentA.runId,
      orgId: parentA.orgId,
      userId: parentA.userId,
      toolCallId: 'c2',
      task: 'already done',
    });
    const stranger = await spawn.spawn({
      parentRunId: parentB.runId,
      orgId: parentB.orgId,
      userId: parentB.userId,
      toolCallId: 'c3',
      task: 'not yours',
    });
    runRow(world, finished.runId).status = RUN_STATUS.SUCCEEDED;

    const result = await cancel.execute({
      runId: parentA.runId,
      auth: FIXED_AUTH,
    });

    assert.deepEqual(result.cancelledDescendants, [mine.runId]);
    assert.equal(runRow(world, finished.runId).cancel_requested_at, null);
    assert.equal(runRow(world, stranger.runId).cancel_requested_at, null);
  });

  it('keeps a child’s own earlier cancel reason', async () => {
    const { create, cancel, spawn } = services(world);
    const parent = await parentRun(world, create);
    const child = await spawn.spawn({
      parentRunId: parent.runId,
      orgId: parent.orgId,
      userId: parent.userId,
      toolCallId: 'c1',
      task: 'a',
    });

    await cancel.execute({
      runId: child.runId,
      auth: FIXED_AUTH,
      reason: 'child specific reason',
    });
    await cancel.execute({
      runId: parent.runId,
      auth: FIXED_AUTH,
      reason: 'parent reason',
    });

    assert.equal(
      runRow(world, child.runId).cancel_reason,
      'child specific reason',
      'cancel intent is first-writer-wins, including across the cascade',
    );
  });

  it('reaps live children of an already-terminal parent', async () => {
    const { create, cancel, spawn } = services(world);
    const parent = await parentRun(world, create);
    const child = await spawn.spawn({
      parentRunId: parent.runId,
      orgId: parent.orgId,
      userId: parent.userId,
      toolCallId: 'c1',
      task: 'orphan',
    });
    // The parent failed on its own; its child is still burning budget.
    runRow(world, parent.runId).status = RUN_STATUS.FAILED;

    const result = await cancel.execute({
      runId: parent.runId,
      auth: FIXED_AUTH,
    });

    assert.equal(result.terminal, true);
    assert.deepEqual(result.cancelledDescendants, [child.runId]);
    assert.ok(runRow(world, child.runId).cancel_requested_at);
  });

  it('refuses to spawn a new child under a cancelled parent', async () => {
    const { create, cancel, spawn } = services(world);
    const parent = await parentRun(world, create);
    const base = {
      parentRunId: parent.runId,
      orgId: parent.orgId,
      userId: parent.userId,
    };
    await cancel.execute({ runId: parent.runId, auth: FIXED_AUTH });

    await assert.rejects(
      () => spawn.spawn({ ...base, toolCallId: 'c9', task: 'too late' }),
      (error) => {
        assert.equal(error.code, 'SUBAGENT_PARENT_NOT_RUNNABLE');
        return true;
      },
    );
    assert.equal(
      world.tables.runs.filter((r) => r.parent_run_id === parent.runId).length,
      0,
    );
  });

  it('commits the intent even when the Redis signal fails', async () => {
    const { create, cancel, spawn } = services(world);
    const parent = await parentRun(world, create);
    const child = await spawn.spawn({
      parentRunId: parent.runId,
      orgId: parent.orgId,
      userId: parent.userId,
      toolCallId: 'c1',
      task: 'a',
    });
    world.cancelSignal.setFail(true);

    const result = await cancel.execute({
      runId: parent.runId,
      auth: FIXED_AUTH,
    });

    assert.equal(result.signalPending, true);
    assert.ok(
      runRow(world, child.runId).cancel_requested_at,
      'MySQL intent is the authority; the child stops at its next check',
    );
  });
});

describe('sub-agent conversations stay out of the owner list', () => {
  /** @type {ReturnType<typeof createFakeRunWorld>} */
  let world;
  beforeEach(() => {
    world = createFakeRunWorld();
  });

  it('marks the child conversation and hides it from listForOwner', async () => {
    const { create, spawn } = services(world);
    const parent = await parentRun(world, create);
    const child = await spawn.spawn({
      parentRunId: parent.runId,
      orgId: parent.orgId,
      userId: parent.userId,
      toolCallId: 'c1',
      task: 'a subtask',
    });
    const childRow = runRow(world, child.runId);
    const scope = { orgId: parent.orgId, userId: parent.userId };
    const repos = world.createRepositories(world.rootDb);

    assert.equal(
      world.tables.conversations.find(
        (c) => c.conversation_id === childRow.conversation_id,
      ).parent_run_id,
      parent.runId,
    );

    const listed = await repos.conversations.listForOwner(scope);
    assert.equal(
      listed.some((c) => c.conversationId === childRow.conversation_id),
      false,
      'a fan-out must not push rows into the owner’s sidebar',
    );
    assert.equal(listed.length, 1, 'only the parent conversation is listed');

    // Hidden from the list is not hidden from the user: the transcript must
    // still be readable by id, which archiving it would have broken.
    const byId = await repos.conversations.getById(
      childRow.conversation_id,
      scope,
    );
    assert.equal(byId.conversationId, childRow.conversation_id);
    assert.equal(byId.parentRunId, parent.runId);
    assert.equal(byId.archivedAt, null);

    const withChildren = await repos.conversations.listForOwner(scope, {
      includeSubagent: true,
    });
    assert.equal(withChildren.length, 2);
  });
});
