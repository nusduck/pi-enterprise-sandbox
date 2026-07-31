import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { collectReferencedFiles } from '../src/widgets/context-inspector/ContextInspector.tsx';

describe('Files and Artifacts display boundary', () => {
  it('shows structured workspace file inputs once and excludes submitted artifacts', () => {
    const files = collectReferencedFiles(
      [
        {
          name: 'read',
          input: { path: '/home/sandbox/workspace/notes.md' },
        },
        {
          name: 'write',
          input: {
            file_path: '/home/sandbox/workspace/report.md',
            content: 'not a path',
          },
        },
        {
          name: 'read',
          input: { path: '/home/sandbox/workspace/notes.md' },
        },
      ],
      ['/home/sandbox/workspace/report.md'],
    );

    assert.deepEqual(files, [{
      path: '/home/sandbox/workspace/notes.md',
      name: 'notes.md',
      toolName: 'read',
    }]);
  });

  it('does not misclassify shell commands or arbitrary prose as file paths', () => {
    const files = collectReferencedFiles([
      {
        name: 'bash',
        input: {
          command: 'ls -la /home/sandbox/workspace',
          query: 'find every markdown file',
        },
      },
    ]);
    assert.deepEqual(files, []);
  });
});
