/**
 * Replay of a real captured run: 40 SSE frames from a live stack (create run →
 * process_start → assistant answer → run.completed), fed through the same
 * ingest path the browser uses.
 *
 * Synthetic fixtures cannot catch a wire-shape drift between Agent and
 * frontend; this one does, because the frames are exactly what the Agent sent.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createEntityBridge } from '../src/features/chat/entityBridge.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUN_ID = '01KYWQY8ZGW9ZY14T1C3JA6QXM';
const PROCESS_ID = '01KYWQYDTBDCFMPW1TE62WX24R';

function ingestFixture() {
  const frames = JSON.parse(
    readFileSync(join(__dirname, 'fixtures/live-run-sse.json'), 'utf8'),
  ) as unknown[];
  const bridge = createEntityBridge();
  bridge.beginRun({ runId: RUN_ID, conversationId: 'c-live' });
  for (const frame of frames) bridge.ingestAgentEvent(RUN_ID, frame as never);
  const store = bridge.getStore();
  bridge.dispose();
  return { store, frameCount: frames.length };
}

describe('live run replay (captured from a running stack)', () => {
  it('applies every frame and reaches the terminal status', () => {
    const { store, frameCount } = ingestFixture();
    const run = store.runsById[RUN_ID];
    assert.equal(frameCount, 40);
    assert.equal(run.status, 'succeeded');
    // Every frame applied in order — a wire-shape drift shows up here as a
    // stalled cursor rather than a silently empty UI.
    assert.equal(run.lastSequence, frameCount);
  });

  it('streams the assistant answer into the transcript', () => {
    const { store } = ingestFixture();
    const assistant = Object.values(store.messagesById).find(
      (m) => m.role === 'assistant',
    );
    assert.ok(assistant, 'assistant message must exist');
    assert.match(assistant.text, /process id/i);
  });

  it('records the served model for the header chip', () => {
    const { store } = ingestFixture();
    assert.equal(store.runsById[RUN_ID].modelId, 'deepseek-v4-flash');
  });

  it('links the process_start tool to its process console', () => {
    const { store } = ingestFixture();
    const tool = Object.values(store.toolExecutionsById).find(
      (t) => t.name === 'process_start',
    );
    assert.ok(tool, 'process_start tool execution must exist');
    assert.equal(tool.status, 'completed');
    assert.equal(tool.processId, PROCESS_ID);
  });
});
