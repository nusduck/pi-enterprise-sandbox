import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ConversationService,
  presentTranscriptMessage,
} from '../../src/application/conversation-service.js';
import { CreateRunService } from '../../src/application/create-run-service.js';
import { OwnerScopedNotFoundError } from '../../src/application/errors.js';
import {
  createFakeRunWorld,
  FIXED_AUTH,
} from './helpers/fake-run-world.js';

function createService(world, sessionProvisioner = null) {
  return new ConversationService({
    transactionManager: world.transactionManager,
    createRepositories: world.createRepositories,
    db: world.rootDb,
    generateId: world.generateId,
    now: () => new Date('2026-07-18T06:00:00.000Z'),
    sessionProvisioner,
  });
}

describe('ConversationService MySQL authority', () => {
  it('preserves durable message metadata in the browser transcript', () => {
    const message = presentTranscriptMessage({
      messageId: 'msg_01',
      runId: 'run_01',
      role: 'assistant',
      messageType: 'chat',
      sequenceNo: 42,
      contentJson: { text: 'durable answer' },
      createdAt: '2026-07-18T06:00:00.123Z',
    });

    assert.deepEqual(message, {
      id: 'msg_01',
      message_id: 'msg_01',
      run_id: 'run_01',
      role: 'assistant',
      content: [{ type: 'text', text: 'durable answer' }],
      sequence_no: 42,
      created_at: '2026-07-18T06:00:00.123Z',
    });
  });

  it('renders the current user turn from legacy full-context rows', () => {
    const message = presentTranscriptMessage({
      messageId: 'msg_legacy',
      role: 'user',
      messageType: 'text',
      contentJson: {
        messages: [
          { role: 'user', content: [{ type: 'text', text: '你好呀' }] },
          { role: 'assistant', content: [{ type: 'text', text: '你好！' }] },
          { role: 'user', content: [{ type: 'text', text: '总结这个文档' }] },
        ],
      },
    });

    assert.equal(message.content[0].text, '总结这个文档');
  });

  it('returns an empty list for a trusted owner that has not been provisioned', async () => {
    const service = createService(createFakeRunWorld());
    assert.deepEqual(await service.list(FIXED_AUTH), []);
  });

  it('creates, lists, gets, and archives an owner-scoped conversation', async () => {
    const world = createFakeRunWorld();
    const service = createService(world);

    const created = await service.create(FIXED_AUTH, { title: 'MySQL chat' });
    assert.match(created.id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.equal(created.title, 'MySQL chat');
    assert.equal(created.messages.length, 0);
    assert.ok(created.agent_session_id);

    const refs = world.tables.conversation_external_refs;
    assert.equal(refs.length, 1);
    assert.equal(refs[0].external_subject, created.id);
    assert.equal(refs[0].conversation_id, created.id);

    const listed = await service.list(FIXED_AUTH);
    assert.deepEqual(listed.map((row) => row.id), [created.id]);
    assert.equal((await service.get(created.id, FIXED_AUTH)).title, 'MySQL chat');

    const foreign = {
      ...FIXED_AUTH,
      externalUserId: 'different-user',
    };
    const foreignConversation = await service.create(foreign, {
      title: 'Foreign chat',
    });
    assert.deepEqual(
      (await service.list(foreign)).map((row) => row.id),
      [foreignConversation.id],
    );
    await assert.rejects(
      service.get(created.id, foreign),
      OwnerScopedNotFoundError,
    );

    await service.delete(created.id, FIXED_AUTH);
    assert.deepEqual(await service.list(FIXED_AUTH), []);
    await assert.rejects(
      service.get(created.id, FIXED_AUTH),
      OwnerScopedNotFoundError,
    );
    assert.equal(world.tables.conversations[0].status, 'archived');
    assert.ok(world.tables.conversations[0].archived_at);
    // Durable children remain; DELETE must not cascade session/run history.
    assert.ok(
      world.tables.agent_sessions.some(
        (session) => session.conversation_id === created.id,
      ),
    );

    const createRun = new CreateRunService({
      transactionManager: world.transactionManager,
      createRepositories: world.createRepositories,
      generateId: world.generateId,
      now: () => new Date('2026-07-18T06:00:00.000Z'),
      runQueue: world.runQueue,
    });
    await assert.rejects(
      createRun.execute({
        messages: [{ role: 'user', content: 'do not reopen archived chat' }],
        auth: { ...FIXED_AUTH, externalConversationId: created.id },
        traceId: 'a'.repeat(32),
        idempotencyKey: 'archived-conversation-run',
      }),
      OwnerScopedNotFoundError,
    );
  });

  it('rejects titles outside the schema limit before writing', async () => {
    const world = createFakeRunWorld();
    const service = createService(world);
    await assert.rejects(
      service.create(FIXED_AUTH, { title: 'x'.repeat(501) }),
      /title exceeds max length 500/,
    );
    assert.equal(world.tables.conversations.length, 0);
    await assert.rejects(
      service.create(FIXED_AUTH, { title: { nested: true } }),
      /title must be a string/,
    );
    await assert.rejects(
      service.create(FIXED_AUTH, null),
      /body must be an object/,
    );
  });

  it('rejects malformed public conversation ids as validation errors', async () => {
    const service = createService(createFakeRunWorld());
    await assert.rejects(service.get('not-a-ulid', FIXED_AUTH), /must be a ULID/);
    await assert.rejects(service.delete('not-a-ulid', FIXED_AUTH), /must be a ULID/);
  });

  it('ensures and reuses a formal SandboxSession without inventing a Run', async () => {
    const world = createFakeRunWorld();
    const calls = [];
    const service = createService(world, {
      async ensure(input) {
        calls.push(input);
        return { status: 'ACTIVE' };
      },
    });

    const first = await service.ensureSession(FIXED_AUTH, {
      traceId: 'a'.repeat(32),
    });
    assert.match(first.conversation_id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.equal(first.reused_session, false);
    assert.equal(first.status, 'ACTIVE');
    assert.equal(calls[0].runId, undefined);
    assert.equal(calls[0].executionFenceToken, undefined);
    assert.equal(calls[0].sandboxSessionId, first.session_id);
    assert.equal(calls[0].workspaceId, first.workspace_id);

    const second = await service.ensureSession(FIXED_AUTH, {
      conversationId: first.conversation_id,
      traceId: 'b'.repeat(32),
    });
    assert.equal(second.conversation_id, first.conversation_id);
    assert.equal(second.session_id, first.session_id);
    assert.equal(second.reused_session, true);
    assert.equal(calls.length, 2);

    const foreign = { ...FIXED_AUTH, externalUserId: 'foreign-owner' };
    await assert.rejects(
      service.ensureSession(foreign, {
        conversationId: first.conversation_id,
        traceId: 'c'.repeat(32),
      }),
      OwnerScopedNotFoundError,
    );
    assert.equal(calls.length, 2);
  });

  it('reuses a Run-created internal ULID even when only a legacy external ref exists', async () => {
    const world = createFakeRunWorld();
    const createRun = new CreateRunService({
      transactionManager: world.transactionManager,
      createRepositories: world.createRepositories,
      generateId: world.generateId,
      now: () => new Date('2026-07-18T06:00:00.000Z'),
      runQueue: world.runQueue,
    });
    const createdRun = await createRun.execute({
      messages: [{ role: 'user', content: 'legacy mapped conversation' }],
      auth: {
        ...FIXED_AUTH,
        externalConversationId: 'legacy-conversation-uuid',
      },
      traceId: 'd'.repeat(32),
      idempotencyKey: 'legacy-conversation-create',
    });
    assert.equal(world.tables.conversations.length, 1);
    assert.equal(
      world.tables.conversation_external_refs[0].external_subject,
      'legacy-conversation-uuid',
    );

    const calls = [];
    const service = createService(world, {
      async ensure(input) {
        calls.push(input);
        return { status: 'ACTIVE' };
      },
    });
    const ensured = await service.ensureSession(FIXED_AUTH, {
      conversationId: createdRun.conversationId,
      traceId: 'e'.repeat(32),
    });
    assert.equal(ensured.conversation_id, createdRun.conversationId);
    assert.equal(ensured.agent_session_id, createdRun.agentSessionId);
    assert.equal(world.tables.conversations.length, 1);
    assert.equal(calls.length, 1);
  });
});
