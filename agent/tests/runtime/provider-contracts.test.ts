import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalSubmittedArtifact } from '../../src/runtime/providers/submit-artifact.js';
import { createInteractionRequester } from '../../src/application/interaction-requester.js';
import {
  installUserQuestionBridge,
  runWithInteractionRequester,
} from '../../src/runtime/providers/user-questions.js';
import { runWithToolExecutionContext } from '../../src/runtime/providers/tool-execution-context.js';

test('submit_artifact returns exactly the declared snake_case output contract', () => {
  const value = canonicalSubmittedArtifact(
    {
      artifactId: 'artifact-01',
      name: null,
      mimeType: null,
      sha256: 'a'.repeat(64),
      size: 12,
    },
    { path: 'reports/result.md' },
  );
  assert.deepEqual(value, {
    artifact_id: 'artifact-01',
    name: 'result.md',
    mime_type: 'application/octet-stream',
    sha256: 'a'.repeat(64),
    size: 12,
  });
  assert.deepEqual(Object.keys(value).sort(), [
    'artifact_id',
    'mime_type',
    'name',
    'sha256',
    'size',
  ]);
});

test('user-question bridge binds the active Run tool execution', async () => {
  let ask: ((request: Record<string, unknown>) => Promise<unknown>) | undefined;
  let registrations = 0;
  const service = {
    registerProvider(provider: { ask: (request: Record<string, unknown>) => Promise<unknown> }) {
      registrations += 1;
      ask = provider.ask;
      return () => undefined;
    },
  };
  const ctx = {
    get(name: string) {
      assert.equal(name, 'userQuestions');
      return service;
    },
  };
  installUserQuestionBridge(ctx);
  installUserQuestionBridge(ctx);
  assert.equal(registrations, 1);
  assert.ok(ask);

  let observed: Record<string, unknown> | undefined;
  const expectedAnswer = { answers: [{ id: 'confirm', selected: ['继续'] }] };
  const answer = await runWithInteractionRequester(
    async (request) => {
      observed = request;
      return expectedAnswer;
    },
    () => runWithToolExecutionContext(
      {
        callId: 'call-01',
        toolName: 'ask_user_question',
        args: { questions: [] },
      },
      () => ask?.({
        questions: [{ id: 'confirm', question: '继续吗？' }],
        agent: { id: 'agent-01' },
      }),
    ),
  );

  assert.deepEqual(answer, expectedAnswer);
  assert.deepEqual(observed, {
    questions: [{ id: 'confirm', question: '继续吗？' }],
    agent: { id: 'agent-01' },
    toolCallId: 'call-01',
    toolName: 'ask_user_question',
    args: { questions: [] },
  });
  await assert.rejects(
    () => ask?.({ questions: [] }),
    /outside an active Run tool execution/,
  );
});

test('interaction requester durably parks the Run instead of fabricating an answer', async () => {
  let recorded: Record<string, unknown> | undefined;
  let parked: unknown;
  const requester = createInteractionRequester({
    recorder: {
      async requestInteraction(input: Record<string, unknown>) {
        recorded = input;
        return { durablePending: { interactionId: 'interaction-01' } };
      },
    },
    runSuspensionPort: { onDurableInteractionPending: (pending) => { parked = pending; } },
  });

  await assert.rejects(
    () => requester({
      toolCallId: 'call-02',
      toolName: 'ask_user_question',
      args: { questions: [] },
      questions: [{
        id: 'mode',
        header: '模式',
        question: '选择模式',
        options: [{ label: '快速' }, { label: '稳妥' }],
      }],
    }),
    /user interaction pending/,
  );
  assert.deepEqual(recorded, {
    toolCallId: 'call-02',
    toolName: 'ask_user_question',
    args: { questions: [] },
    interactionType: 'select',
    title: '模式',
    message: '选择模式',
    options: ['快速', '稳妥'],
    placeholder: null,
  });
  assert.deepEqual(parked, { interactionId: 'interaction-01' });
});
