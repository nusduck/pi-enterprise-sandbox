/**
 * SubagentSpawnService — delegated spawns (`targetAgentName`).
 * docs/design/agent-delegation.md D3. Offline fakes only.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { CreateRunService } from '../../src/application/create-run-service.js';
import {
  SubagentLimitError,
  SubagentSpawnService,
} from '../../src/application/subagent-spawn-service.js';
import { ValidationError } from '../../src/application/errors.js';
import { createFakeRunWorld, FIXED_AUTH, TRACE } from './helpers/fake-run-world.js';

const NOW = () => new Date('2026-09-24T06:00:00.000Z');
const MESSAGES = [{ role: 'user', content: [{ type: 'text', text: 'plan it' }] }];

/** @param {ReturnType<typeof createFakeRunWorld>} world */
function buildSpawn(world) {
  return new SubagentSpawnService({
    transactionManager: world.transactionManager,
    createRepositories: world.createRepositories,
    generateId: world.generateId,
    now: NOW,
    runQueue: world.runQueue,
  });
}

/** @param {ReturnType<typeof createFakeRunWorld>} world */
async function createParentRun(world) {
  const created = await new CreateRunService({
    transactionManager: world.transactionManager,
    createRepositories: world.createRepositories,
    generateId: world.generateId,
    now: NOW,
    runQueue: world.runQueue,
  }).execute({ messages: MESSAGES, auth: FIXED_AUTH, traceId: TRACE, idempotencyKey: 'parent-1' });
  const row = world.tables.tbl_agsvc_runs.find((r) => r.run_id === created.runId);
  const conversation = world.tables.tbl_agsvc_conversations.find(
    (r) => r.conversation_id === row.conversation_id,
  );
  return {
    runId: created.runId,
    orgId: String(row.org_id),
    userId: String(row.user_id),
    agentId: String(conversation.agent_id),
    agentVersionId: String(row.agent_version_id),
  };
}

/**
 * Seed an agent definition with (optionally) an active version.
 * @param {ReturnType<typeof createFakeRunWorld>} world
 */
async function seedAgent(world, { orgId, userId, name, status = 'active', versionStatus = 'active', withVersion = true }) {
  const repos = world.createRepositories(world.rootDb);
  const agentId = world.generateId();
  await repos.catalog.createDefinition({ agentId, orgId, name, status, createdBy: userId });
  let agentVersionId = null;
  if (withVersion) {
    agentVersionId = world.generateId();
    await repos.catalog.createVersion({
      agentVersionId,
      agentId,
      versionNo: 1,
      configJson: { schemaVersion: 1, systemPrompt: `I am ${name}` },
      status: versionStatus,
      createdBy: userId,
    });
    await repos.catalog.setActiveVersion(agentId, agentVersionId);
  }
  return { agentId, agentVersionId };
}

function spawnInput(parent, extra = {}) {
  return {
    toolCallId: 'call-1',
    parentRunId: parent.runId,
    orgId: parent.orgId,
    userId: parent.userId,
    task: 'analyse the sales table',
    label: 'sales',
    ...extra,
  };
}

/** @param {ReturnType<typeof createFakeRunWorld>} world */
function childRows(world, parentRunId) {
  return world.tables.tbl_agsvc_runs.filter((r) => r.parent_run_id === parentRunId);
}

describe('SubagentSpawnService.spawn with targetAgentName', () => {
  /** @type {ReturnType<typeof createFakeRunWorld>} */
  let world;
  beforeEach(() => {
    world = createFakeRunWorld();
  });

  it('binds the child to the target agent active version', async () => {
    const parent = await createParentRun(world);
    const target = await seedAgent(world, { orgId: parent.orgId, userId: parent.userId, name: 'data-analyst' });
    assert.notEqual(target.agentVersionId, parent.agentVersionId);

    const result = await buildSpawn(world).spawn(spawnInput(parent, { targetAgentName: 'data-analyst' }));

    const child = world.tables.tbl_agsvc_runs.find((r) => r.run_id === result.runId);
    assert.equal(child.agent_version_id, target.agentVersionId);
    assert.equal(child.subagent_depth, 1);
    const conversation = world.tables.tbl_agsvc_conversations.find(
      (r) => r.conversation_id === child.conversation_id,
    );
    assert.equal(conversation.agent_id, target.agentId);
    const session = world.tables.tbl_agsvc_agent_sessions.find(
      (r) => r.agent_session_id === child.agent_session_id,
    );
    assert.equal(session.agent_version_id, target.agentVersionId);
    const message = world.tables.tbl_agsvc_messages.find(
      (r) => r.message_id === child.triggering_message_id,
    );
    const content = typeof message.content_json === 'string'
      ? JSON.parse(message.content_json)
      : message.content_json;
    assert.equal(content.agentId, target.agentId);
  });

  it('keeps the parent agent when no target is named (control)', async () => {
    const parent = await createParentRun(world);
    await seedAgent(world, { orgId: parent.orgId, userId: parent.userId, name: 'data-analyst' });

    const result = await buildSpawn(world).spawn(spawnInput(parent));

    const child = world.tables.tbl_agsvc_runs.find((r) => r.run_id === result.runId);
    assert.equal(child.agent_version_id, parent.agentVersionId);
    const conversation = world.tables.tbl_agsvc_conversations.find(
      (r) => r.conversation_id === child.conversation_id,
    );
    assert.equal(conversation.agent_id, parent.agentId);
  });

  for (const [label, seed] of [
    ['missing', null],
    ['another org', { orgOverride: true }],
    ['inactive', { status: 'disabled' }],
    ['without an active version', { withVersion: false }],
    ['with an inactive active version', { versionStatus: 'draft' }],
  ]) {
    it(`refuses a target that is ${label} with one indistinguishable code`, async () => {
      const parent = await createParentRun(world);
      if (seed) {
        const orgId = seed.orgOverride ? world.generateId() : parent.orgId;
        await seedAgent(world, { orgId, userId: parent.userId, name: 'data-analyst', ...seed });
      }

      await assert.rejects(
        buildSpawn(world).spawn(spawnInput(parent, { targetAgentName: 'data-analyst' })),
        (err) =>
          err instanceof SubagentLimitError &&
          err.code === 'DELEGATION_TARGET_UNAVAILABLE' &&
          err.message === 'agent "data-analyst" is not available for delegation',
      );
      assert.equal(childRows(world, parent.runId).length, 0, 'no child may be created');
      assert.equal(world.enqueuedJobs.filter((j) => j.runId !== parent.runId).length, 0);
    });
  }

  it('rejects an empty target name', async () => {
    const parent = await createParentRun(world);
    await assert.rejects(
      buildSpawn(world).spawn(spawnInput(parent, { targetAgentName: '  ' })),
      ValidationError,
    );
  });

  it('replays the same delegated child for the same tool call', async () => {
    const parent = await createParentRun(world);
    await seedAgent(world, { orgId: parent.orgId, userId: parent.userId, name: 'data-analyst' });
    const service = buildSpawn(world);

    const first = await service.spawn(spawnInput(parent, { targetAgentName: 'data-analyst' }));
    const again = await service.spawn(spawnInput(parent, { targetAgentName: 'data-analyst' }));

    assert.equal(again.replayed, true);
    assert.equal(again.runId, first.runId);
    assert.equal(childRows(world, parent.runId).length, 1);
  });

  it('treats a different target under the same tool call as a conflict, not a replay', async () => {
    const parent = await createParentRun(world);
    await seedAgent(world, { orgId: parent.orgId, userId: parent.userId, name: 'data-analyst' });
    await seedAgent(world, { orgId: parent.orgId, userId: parent.userId, name: 'code-reviewer' });
    const service = buildSpawn(world);

    await service.spawn(spawnInput(parent, { targetAgentName: 'data-analyst' }));
    await assert.rejects(
      service.spawn(spawnInput(parent, { targetAgentName: 'code-reviewer' })),
    );
    assert.equal(childRows(world, parent.runId).length, 1);
  });
});
