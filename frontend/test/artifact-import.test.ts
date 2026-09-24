import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldIncludeListedArtifact } from '../src/widgets/context-inspector/ContextInspector.tsx';

describe('Artifact import projection', () => {
  it('keeps session-listed artifacts when the list omits run_id', () => {
    assert.equal(shouldIncludeListedArtifact('run-1', ''), true);
  });

  it('still excludes a listed artifact explicitly belonging to another run', () => {
    assert.equal(shouldIncludeListedArtifact('run-1', 'run-2'), false);
  });
});
