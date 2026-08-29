import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadPromptImagesFromAttachmentStore,
} from '../../src/infrastructure/dsh/prompt-image-loader.js';

function imageResponse(bytes, mime = 'image/png', sha256 = null) {
  const headers = new Headers({ 'content-type': mime });
  if (sha256) headers.set('x-dataset-sha256', sha256);
  return new Response(bytes, { headers });
}

describe('prompt image loader', () => {
  it('resolves an owner-scoped attachment id into Pi image content', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const calls = [];
    const images = await loadPromptImagesFromAttachmentStore({
      attachmentStore: {
        async download(input) {
          calls.push(input);
          return imageResponse(bytes, 'image/png', sha256);
        },
      },
      sandboxSessionId: 'session-1',
      attachments: [{
        attachmentId: 'dataset-1',
        mimeType: 'image/png',
        size: bytes.length,
      }],
    });
    assert.equal(calls[0].attachmentId, 'dataset-1');
    assert.equal(calls[0].sandboxSessionId, 'session-1');
    assert.deepEqual(images, [{
      type: 'image',
      data: bytes.toString('base64'),
      mimeType: 'image/png',
    }]);
  });

  it('rejects changed content and unsupported image types', async () => {
    const changedPng = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('changed'),
    ]);
    await assert.rejects(
      loadPromptImagesFromAttachmentStore({
        attachmentStore: {
          download: async () => imageResponse(
            changedPng,
            'image/png',
            '0'.repeat(64),
          ),
        },
        sandboxSessionId: 'session-1',
        attachments: [{ attachmentId: 'dataset-1', mimeType: 'image/png' }],
      }),
      /hash no longer matches/,
    );
    await assert.rejects(
      loadPromptImagesFromAttachmentStore({
        attachmentStore: { download: async () => imageResponse(Buffer.from('x')) },
        sandboxSessionId: 'session-1',
        attachments: [{ attachmentId: 'dataset-2', mimeType: 'image/svg+xml' }],
      }),
      /Unsupported prompt image type/,
    );
    await assert.rejects(
      loadPromptImagesFromAttachmentStore({
        attachmentStore: {
          download: async () => imageResponse(Buffer.from('not-a-png')),
        },
        sandboxSessionId: 'session-1',
        attachments: [{ attachmentId: 'dataset-3', mimeType: 'image/png' }],
      }),
      /bytes do not match declared type/,
    );
  });
});
