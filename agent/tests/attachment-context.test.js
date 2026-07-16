/**
 * B5 — attachment context normalization + prompt injection.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAttachment,
  extractMessageAttachments,
  formatAttachmentPromptBlock,
  injectAttachmentContext,
} from '../runtime/attachment-context.js';
import { toPersistableMessages } from '../runtime/message-helpers.js';

describe('attachment context (B5)', () => {
  it('normalizeAttachment maps full ADR §4.5 fields', () => {
    const n = normalizeAttachment({
      attachment_id: 'att_1',
      filename: 'report.xlsx',
      path: 'uploads/att_1/report.xlsx',
      mime_type: 'application/vnd.ms-excel',
      size: 99,
      upload_time: '2026-07-12T00:00:00Z',
    });
    assert.equal(n.attachment_id, 'att_1');
    assert.equal(n.filename, 'report.xlsx');
    assert.equal(n.path, 'uploads/att_1/report.xlsx');
    assert.equal(n.workspace_path, 'uploads/att_1/report.xlsx');
    assert.equal(n.mime_type, 'application/vnd.ms-excel');
    assert.equal(n.size, 99);
    assert.equal(n.upload_time, '2026-07-12T00:00:00Z');
  });

  it('normalizeAttachment accepts camelCase + name fallback', () => {
    const n = normalizeAttachment({
      attachmentId: 'att_x',
      name: 'a.txt',
      path: 'uploads/att_x/a.txt',
      mimeType: 'text/plain',
      size: 3,
    });
    assert.equal(n.attachment_id, 'att_x');
    assert.equal(n.filename, 'a.txt');
    assert.equal(n.mime_type, 'text/plain');
  });

  it('extractMessageAttachments reads multi-file manifest', () => {
    const msg = {
      role: 'user',
      content: [{ type: 'text', text: 'analyze' }],
      attachments: [
        {
          attachment_id: 'att_a',
          name: 'a.txt',
          path: 'uploads/att_a/a.txt',
          size: 1,
          mime_type: 'text/plain',
        },
        {
          attachment_id: 'att_b',
          name: 'b.md',
          path: 'uploads/att_b/b.md',
          size: 2,
          mime_type: 'text/markdown',
        },
      ],
    };
    const list = extractMessageAttachments(msg);
    assert.equal(list.length, 2);
    assert.equal(list[0].path, 'uploads/att_a/a.txt');
    assert.equal(list[1].filename, 'b.md');
  });

  it('formatAttachmentPromptBlock lists files and forbids uploads/ scan', () => {
    const block = formatAttachmentPromptBlock([
      {
        attachment_id: 'att_a',
        filename: 'a.txt',
        path: 'uploads/att_a/a.txt',
        mime_type: 'text/plain',
        size: 1,
        upload_time: 't1',
      },
      {
        attachment_id: 'att_b',
        filename: 'b.md',
        path: 'uploads/att_b/b.md',
        mime_type: 'text/markdown',
        size: 2,
      },
    ]);
    assert.match(block, /Current-turn attachments/);
    assert.match(block, /uploads\/att_a\/a\.txt/);
    assert.match(block, /uploads\/att_b\/b\.md/);
    assert.match(block, /Do \*\*not\*\* scan/);
    assert.match(block, /attachment_id=`att_a`/);
    assert.equal(formatAttachmentPromptBlock([]), '');
  });

  it('injectAttachmentContext replaces frontend [Attachments] blob', () => {
    const text =
      'Please review\n\n[Attachments]\n- a.txt → uploads/att_a/a.txt';
    const out = injectAttachmentContext(text, [
      {
        attachment_id: 'att_a',
        filename: 'a.txt',
        path: 'uploads/att_a/a.txt',
        mime_type: 'text/plain',
        size: 1,
        upload_time: 't',
      },
    ]);
    assert.match(out, /Please review/);
    assert.match(out, /Current-turn attachments/);
    assert.doesNotMatch(out, /\[Attachments\]/);
    assert.match(out, /mime=`text\/plain`/);
  });

  it('toPersistableMessages keeps attachments on user turns', () => {
    const rows = toPersistableMessages([
      {
        role: 'user',
        content: 'hi',
        attachments: [
          {
            attachment_id: 'att_1',
            name: 'f.txt',
            path: 'uploads/att_1/f.txt',
            size: 1,
            mime_type: 'text/plain',
          },
        ],
      },
      { role: 'assistant', content: 'ok' },
    ]);
    assert.equal(rows[0].attachments.length, 1);
    assert.equal(rows[0].attachments[0].attachment_id, 'att_1');
    assert.equal(rows[1].attachments, undefined);
  });
});
