/**
 * DSH 会话标题 → Conversation.title（application/session-title-projection.ts）。
 * Offline fakes only.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { ConversationService } from '../../src/application/conversation-service.js';
import { CreateRunService } from '../../src/application/create-run-service.js';
import {
  createSessionTitleProjector,
  latestProviderTitle,
} from '../../src/application/session-title-projection.js';
import { createFakeRunWorld, FIXED_AUTH } from './helpers/fake-run-world.js';

const NOW = () => new Date('2026-09-25T06:00:00.000Z');

const providerTitle = (title) => ({ type: 'session/title', data: { title, source: { kind: 'provider' } } });
const fallbackTitle = (title) => ({ type: 'session/title', data: { title, source: { kind: 'fallback' } } });

async function newConversation(world, title) {
  const service = new ConversationService({
    transactionManager: world.transactionManager,
    createRepositories: world.createRepositories,
    db: world.rootDb,
    generateId: world.generateId,
    now: NOW,
  });
  const created = await service.create(FIXED_AUTH, title === undefined ? {} : { title });
  const conversationId = created.conversation_id ?? created.conversationId ?? created.id;
  const row = world.tables.tbl_agsvc_conversations.find((r) => r.conversation_id === conversationId);
  return {
    // The fake DB replaces rows on update, so always re-read by id.
    get row() {
      return world.tables.tbl_agsvc_conversations.find((r) => r.conversation_id === conversationId);
    },
    owner: { orgId: String(row.org_id), userId: String(row.user_id) },
    sessionId: String(row.current_agent_session_id),
  };
}

describe('latestProviderTitle', () => {
  it('takes the newest model-generated title and ignores the deterministic fallback', () => {
    assert.equal(latestProviderTitle([fallbackTitle('Run the shell'), providerTitle('Run echo via bash')]), 'Run echo via bash');
    assert.equal(latestProviderTitle([providerTitle('old'), providerTitle('  new \n title ')]), 'new title');
    assert.equal(latestProviderTitle([fallbackTitle('only fallback')]), null);
    assert.equal(latestProviderTitle([{ type: 'message', data: {} }]), null);
  });
});

describe('createSessionTitleProjector', () => {
  /** @type {ReturnType<typeof createFakeRunWorld>} */
  let world;
  let project;
  let logs;
  beforeEach(() => {
    world = createFakeRunWorld();
    logs = [];
    project = createSessionTitleProjector({
      transactionManager: world.transactionManager,
      createRepositories: world.createRepositories,
      log: (m) => logs.push(m),
    });
  });

  it('replaces a placeholder title with the model-generated one', async () => {
    const c = await newConversation(world); const { owner, sessionId } = c;
    assert.equal(c.row.title, 'New chat');
    await project(owner, sessionId, [fallbackTitle('Run the shell'), providerTitle('Run echo via bash')]);
    assert.equal(c.row.title, 'Run echo via bash');
  });

  it('replaces the first-prompt title the first Run derived (the real order: Run first, title later)', async () => {
    const created = await new CreateRunService({
      transactionManager: world.transactionManager,
      createRepositories: world.createRepositories,
      generateId: world.generateId,
      now: NOW,
      runQueue: world.runQueue,
    }).execute({
      messages: [{ role: 'user', content: '帮我比较一下 Python 和 Go 在写命令行工具时的优缺点' }],
      auth: FIXED_AUTH,
      traceId: '0af7651916cd43dd8448eb211c80319c',
      idempotencyKey: 'title-run-1',
    });
    const runRow = world.tables.tbl_agsvc_runs.find((r) => r.run_id === created.runId);
    const read = () => world.tables.tbl_agsvc_conversations.find((r) => r.conversation_id === runRow.conversation_id);
    assert.equal(read().title, '帮我比较一下 Python 和 Go 在写命令行工具时的优缺点', 'CreateRunService derives the title');
    await project(
      { orgId: String(runRow.org_id), userId: String(runRow.user_id) },
      String(runRow.agent_session_id),
      [providerTitle('Python 与 Go 命令行对比')],
    );
    assert.equal(read().title, 'Python 与 Go 命令行对比');
  });

  it('never overwrites a title the caller chose', async () => {
    const c = await newConversation(world, 'Quarterly review'); const { owner, sessionId } = c;
    await project(owner, sessionId, [providerTitle('Something else')]);
    assert.equal(c.row.title, 'Quarterly review');
  });

  it('does not write the deterministic fallback, so the model title can still land later', async () => {
    const c = await newConversation(world); const { owner, sessionId } = c;
    await project(owner, sessionId, [fallbackTitle('Run the shell')]);
    assert.equal(c.row.title, 'New chat');
    await project(owner, sessionId, [providerTitle('Run echo via bash')]);
    assert.equal(c.row.title, 'Run echo via bash');
  });

  it('is owner-scoped: another owner cannot retitle the conversation', async () => {
    const c = await newConversation(world); const { sessionId } = c;
    await project({ orgId: world.generateId(), userId: world.generateId() }, sessionId, [providerTitle('hijack')]);
    assert.equal(c.row.title, 'New chat');
  });

  it('swallows and logs a projection failure instead of throwing', async () => {
    const broken = createSessionTitleProjector({
      transactionManager: { run: async () => { throw new Error('db down'); } },
      createRepositories: world.createRepositories,
      log: (m) => logs.push(m),
    });
    await broken({ orgId: 'o', userId: 'u' }, 's', [providerTitle('x')]);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /db down/);
  });
});
