/**
 * Vision helpers — model modality gate, mime detection, attachment load.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  baseMimeType,
  isImageAttachment,
  loadTurnAttachmentImages,
  mimeFromFilename,
  modelSupportsVision,
  prepareImageContent,
  resolveImageMime,
} from '../src/runtime/vision-images.js';
import {
  formatAttachmentPromptBlock,
  injectAttachmentContext,
} from '../src/runtime/attachment-context.js';

describe('vision-images', () => {
  it('modelSupportsVision reads registry input_modalities and pi input', () => {
    assert.equal(modelSupportsVision(null), false);
    assert.equal(modelSupportsVision({ input_modalities: ['text'] }), false);
    assert.equal(
      modelSupportsVision({ input_modalities: ['text', 'image'] }),
      true,
    );
    assert.equal(modelSupportsVision({ input: ['text', 'image'] }), true);
  });

  it('resolveImageMime from mime and extension', () => {
    assert.equal(resolveImageMime({ mime_type: 'image/png' }), 'image/png');
    assert.equal(resolveImageMime({ mime_type: 'image/jpg' }), 'image/jpeg');
    assert.equal(
      resolveImageMime({ filename: 'shot.PNG', mime_type: 'application/octet-stream' }),
      'image/png',
    );
    assert.equal(resolveImageMime({ path: 'uploads/a/x.webp' }), 'image/webp');
    assert.equal(resolveImageMime({ filename: 'a.csv', mime_type: 'text/csv' }), null);
    assert.equal(mimeFromFilename('photo.jpeg'), 'image/jpeg');
    assert.equal(baseMimeType('image/png; charset=binary'), 'image/png');
    assert.equal(isImageAttachment({ filename: 'a.png' }), true);
    assert.equal(isImageAttachment({ filename: 'a.txt' }), false);
  });

  it('prepareImageContent base64-encodes a small PNG without resize failure', async () => {
    // 1x1 transparent PNG
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const out = await prepareImageContent(png, 'image/png', { autoResize: false });
    assert.equal(out.ok, true);
    assert.equal(out.image.type, 'image');
    assert.equal(out.image.mimeType, 'image/png');
    assert.ok(out.image.data.length > 10);
  });

  it('loadTurnAttachmentImages skips when vision disabled', async () => {
    const out = await loadTurnAttachmentImages({
      client: {
        downloadFileStream: async () => {
          throw new Error('should not download');
        },
      },
      sessionId: 's1',
      attachments: [{ filename: 'a.png', path: 'uploads/a/a.png', mime_type: 'image/png' }],
      visionEnabled: false,
    });
    assert.equal(out.images.length, 0);
    assert.equal(out.loaded, 0);
  });

  it('loadTurnAttachmentImages downloads and prepares images', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const out = await loadTurnAttachmentImages({
      client: {
        downloadFileStream: async () => ({
          ok: true,
          arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
        }),
      },
      sessionId: 's1',
      attachments: [
        {
          attachment_id: 'att_1',
          filename: 'dot.png',
          path: 'uploads/att_1/dot.png',
          mime_type: 'image/png',
          size: png.length,
        },
        {
          attachment_id: 'att_2',
          filename: 'note.txt',
          path: 'uploads/att_2/note.txt',
          mime_type: 'text/plain',
          size: 4,
        },
      ],
      visionEnabled: true,
    });
    assert.equal(out.loaded, 1);
    assert.equal(out.images.length, 1);
    assert.equal(out.images[0].type, 'image');
    assert.equal(out.images[0].mimeType, 'image/png');
  });

  it('attachment prompt mentions vision when images inlined', () => {
    const block = formatAttachmentPromptBlock(
      [
        {
          attachment_id: 'att_1',
          filename: 'a.png',
          path: 'uploads/att_1/a.png',
          mime_type: 'image/png',
        },
      ],
      { visionEnabled: true, visionImageCount: 1 },
    );
    assert.match(block, /inlined as vision input/);
    const textOnly = injectAttachmentContext('hi', [
      {
        attachment_id: 'att_1',
        filename: 'a.png',
        path: 'uploads/att_1/a.png',
        mime_type: 'image/png',
      },
    ], { visionEnabled: false });
    assert.match(textOnly, /text-only/);
  });
});
