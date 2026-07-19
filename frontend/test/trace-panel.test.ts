import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTraceSpan } from '../src/entities/store.ts';
import {
  buildTraceTree,
  traceMetadataEntries,
} from '../src/widgets/trace-panel/TracePanel.tsx';

test('trace tree preserves parent-child order and owner-bearing spans', () => {
  const root = createTraceSpan({
    id: 'trace:root',
    runId: 'run-1',
    orgId: 'org-1',
    userId: 'user-1',
    spanId: 'root',
    kind: 'run',
    name: 'Run',
    startedAt: '2026-07-19T00:00:00.000Z',
  });
  const child = createTraceSpan({
    id: 'trace:tool',
    runId: 'run-1',
    parentId: root.id,
    spanId: 'tool',
    kind: 'tool',
    name: 'bash',
    startedAt: '2026-07-19T00:00:00.100Z',
  });

  const tree = buildTraceTree([child, root]);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].span.orgId, 'org-1');
  assert.equal(tree[0].children[0].span.id, child.id);
});

test('trace metadata exposes only supported scalar Tool and Model fields', () => {
  assert.deepEqual(
    traceMetadataEntries({
      toolName: 'bash',
      modelId: 'gpt-5',
      provider: 'openai',
      exitCode: 0,
      nested: { secret: 'not rendered' },
      prompt: 'not rendered',
    }),
    [
      { key: 'modelId', label: 'Model', value: 'gpt-5' },
      { key: 'provider', label: 'Provider', value: 'openai' },
      { key: 'toolName', label: 'Tool', value: 'bash' },
      { key: 'exitCode', label: 'Exit', value: '0' },
    ],
  );
});
