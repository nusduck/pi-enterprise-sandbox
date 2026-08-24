/**
 * Attachment draft state machine — no auto-send, send gate, same-name independence.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  INITIAL,
  createState,
  update,
  createAttachmentDraft,
  patchAttachment,
  removeAttachment,
  canSendAttachments,
  hasUploadingAttachments,
  uploadedAttachments,
  activeAttachments,
  validateNewAttachments,
  buildUserTurnWithAttachments,
  ATTACHMENT_LIMITS,
  switchConversation,
  isAllowedAttachmentName,
  extensionOf,
  fileTypeLabel,
  splitAttachmentDisplay,
  pastedImageName,
} from '../src/shared/state/index.ts';

function fakeFile(name: string, size = 10) {
  return { name, size, type: 'text/plain' };
}

describe('attachment drafts', () => {
  it('createAttachmentDraft starts queued with unique localId and idempotency key', () => {
    const a = createAttachmentDraft(fakeFile('a.txt'));
    const b = createAttachmentDraft(fakeFile('a.txt'));
    assert.equal(a.status, 'queued');
    assert.equal(a.name, 'a.txt');
    assert.notEqual(a.localId, b.localId);
    assert.notEqual(a.idempotencyKey, b.idempotencyKey);
  });

  it('same display name are independent drafts (no overwrite / no dedupe)', () => {
    let s = createState(INITIAL);
    const d1 = createAttachmentDraft(fakeFile('report.pdf', 100));
    const d2 = createAttachmentDraft(fakeFile('report.pdf', 200));
    s = update(s, { attachments: [d1, d2] });
    const active = activeAttachments(s.attachments);
    assert.equal(active.length, 2);
    assert.equal(active[0].name, active[1].name);
    assert.notEqual(active[0].localId, active[1].localId);
  });

  it('canSendAttachments blocks queued/uploading/failed; allows uploaded-only', () => {
    const base = createAttachmentDraft(fakeFile('a.txt'));
    assert.equal(canSendAttachments([{ ...base, status: 'queued' }]), false);
    assert.equal(canSendAttachments([{ ...base, status: 'uploading' }]), false);
    assert.equal(canSendAttachments([{ ...base, status: 'failed', error: 'x' }]), false);
    assert.equal(
      canSendAttachments([{ ...base, status: 'uploaded', path: 'uploads/x/a.txt' }]),
      true,
    );
    assert.equal(canSendAttachments([]), true);
    assert.equal(canSendAttachments([{ ...base, status: 'removed' }]), true);
  });

  it('hasUploadingAttachments detects in-flight drafts', () => {
    const a = { ...createAttachmentDraft(fakeFile('a.txt')), status: 'uploading' as const };
    assert.equal(hasUploadingAttachments([a]), true);
    assert.equal(hasUploadingAttachments([{ ...a, status: 'uploaded', path: 'p' }]), false);
  });

  it('removeAttachment soft-removes without deleting other same-name drafts', () => {
    const a = createAttachmentDraft(fakeFile('x.txt'));
    const b = createAttachmentDraft(fakeFile('x.txt'));
    let list = [a, b];
    list = removeAttachment(list, a.localId);
    assert.equal(list.find((d) => d.localId === a.localId)?.status, 'removed');
    assert.equal(list.find((d) => d.localId === b.localId)?.status, 'queued');
  });

  it('removeAttachment aborts in-flight upload controller', () => {
    const a = createAttachmentDraft(fakeFile('x.txt'));
    const ctrl = new AbortController();
    a.status = 'uploading';
    a.abortCtrl = ctrl;
    removeAttachment([a], a.localId);
    assert.equal(ctrl.signal.aborted, true);
  });

  it('patchAttachment transitions queued → uploading → uploaded', () => {
    const d = createAttachmentDraft(fakeFile('n.md'));
    let list = [d];
    list = patchAttachment(list, d.localId, { status: 'uploading' });
    assert.equal(list[0].status, 'uploading');
    list = patchAttachment(list, d.localId, {
      status: 'uploaded',
      attachmentId: 'att_1',
      path: 'uploads/att_1/n.md',
    });
    assert.equal(list[0].status, 'uploaded');
    assert.equal(uploadedAttachments(list).length, 1);
  });

  it('send gate: queued drafts block send until uploaded (queue stuck scenario)', () => {
    // Regression context: drafts must leave "queued" via upload; if upload
    // never starts (async stateRef miss), canSend stays false forever.
    const d = createAttachmentDraft(fakeFile('stuck.txt'));
    assert.equal(canSendAttachments([d]), false);
    assert.equal(hasUploadingAttachments([d]), true);
    const uploaded = {
      ...d,
      status: 'uploaded' as const,
      path: 'uploads/att/stuck.txt',
      attachmentId: 'att_stuck',
    };
    assert.equal(canSendAttachments([uploaded]), true);
    assert.equal(hasUploadingAttachments([uploaded]), false);
  });

  it('validateNewAttachments enforces count and size limits', () => {
    const limits = { ...ATTACHMENT_LIMITS, maxCount: 2, maxFileBytes: 100, maxTurnBytes: 150 };
    const existing = [
      { ...createAttachmentDraft(fakeFile('a.txt', 50)), status: 'uploaded' as const, path: 'p' },
    ];
    assert.equal(validateNewAttachments(existing, [fakeFile('b.txt', 50)], limits).ok, true);
    const tooMany = validateNewAttachments(
      existing,
      [fakeFile('b.txt', 10), fakeFile('c.txt', 10)],
      limits,
    );
    assert.equal(tooMany.ok, false);
    if (!tooMany.ok) assert.equal(tooMany.code, 'turn_attachment_limit');
    const big = validateNewAttachments([], [fakeFile('big.txt', 101)], limits);
    assert.equal(big.ok, false);
    if (!big.ok) assert.equal(big.code, 'attachment_too_large');
    const turn = validateNewAttachments(
      [{ ...createAttachmentDraft(fakeFile('a.txt', 100)), status: 'uploaded' as const, path: 'p' }],
      [fakeFile('b.txt', 60)],
      limits,
    );
    assert.equal(turn.ok, false);
  });

  it('validateNewAttachments denies disallowed extensions (layered whitelist)', () => {
    assert.equal(isAllowedAttachmentName('ok.pdf'), true);
    assert.equal(isAllowedAttachmentName('pack.TAR.GZ'), true);
    assert.equal(extensionOf('pack.TAR.GZ'), '.tar.gz');
    assert.equal(isAllowedAttachmentName('evil.exe'), false);
    const denied = validateNewAttachments([], [fakeFile('evil.exe', 10)]);
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.code, 'attachment_type_denied');
  });

  it('buildUserTurnWithAttachments injects manifest paths (no auto-send side effects)', () => {
    const drafts = [
      {
        ...createAttachmentDraft(fakeFile('a.txt', 3)),
        status: 'uploaded' as const,
        attachmentId: 'att_a',
        path: 'uploads/att_a/a.txt',
      },
      {
        ...createAttachmentDraft(fakeFile('b.md', 4)),
        status: 'uploaded' as const,
        attachmentId: 'att_b',
        path: 'uploads/att_b/b.md',
      },
    ];
    const msg = buildUserTurnWithAttachments('Please review', drafts);
    assert.equal(msg.role, 'user');
    assert.match(msg.content[0] && 'text' in msg.content[0] ? msg.content[0].text : '', /Please review/);
    assert.match(msg.content[0] && 'text' in msg.content[0] ? msg.content[0].text : '', /\[Attachments\]/);
    assert.match(msg.content[0] && 'text' in msg.content[0] ? msg.content[0].text : '', /uploads\/att_a\/a\.txt/);
    assert.equal(msg.attachments.length, 2);
    assert.equal(msg.attachments[0].attachment_id, 'att_a');
  });

  it('attachments-only turn (empty text) still builds manifest', () => {
    const drafts = [
      {
        ...createAttachmentDraft(fakeFile('solo.csv')),
        status: 'uploaded' as const,
        attachmentId: 'att_s',
        path: 'uploads/att_s/solo.csv',
      },
    ];
    const msg = buildUserTurnWithAttachments('   ', drafts);
    assert.match(msg.content[0] && 'text' in msg.content[0] ? msg.content[0].text : '', /^\[Attachments\]/);
    assert.equal(msg.attachments.length, 1);
  });

  it('hides the agent-facing manifest while preserving attachment cards', () => {
    const display = splitAttachmentDisplay(
      'Please review\n\n[Attachments]\n- notes.md → uploads/att_1/notes.md (text/markdown)',
      [],
    );
    assert.equal(display.text, 'Please review');
    assert.equal(display.attachments.length, 1);
    assert.equal(display.attachments[0].name, 'notes.md');
    assert.equal(display.attachments[0].path, 'uploads/att_1/notes.md');
    assert.equal(display.attachments[0].mime_type, 'text/markdown');
  });

  it('keeps ordinary prose containing the Attachments label intact', () => {
    const text = 'Use this heading:\n[Attachments]\nNo manifest here.';
    assert.equal(splitAttachmentDisplay(text, []).text, text);
  });

  it('derives compact file type labels without exposing raw MIME types', () => {
    assert.equal(fileTypeLabel('report.PDF'), 'PDF');
    assert.equal(fileTypeLabel('no-extension', 'image/webp'), 'IMG');
  });

  it('switchConversation clears attachment drafts', () => {
    let s = createState(INITIAL);
    s = update(s, {
      attachments: [createAttachmentDraft(fakeFile('x.txt'))],
      conversationId: 'c1',
    });
    s = switchConversation(s, { conversationId: 'c2', messages: [] });
    assert.deepEqual(s.attachments, []);
  });

  it('selecting files never implies auto-send (state stays non-streaming)', () => {
    let s = createState(INITIAL);
    const d = createAttachmentDraft(fakeFile('note.txt'));
    s = update(s, { attachments: [d] });
    s = update(s, {
      attachments: patchAttachment(s.attachments, d.localId, {
        status: 'uploaded',
        path: 'uploads/1/note.txt',
        attachmentId: 'att_1',
      }),
    });
    assert.equal(s.isStreaming, false);
    assert.equal(s.messages.length, 0);
    assert.equal(canSendAttachments(s.attachments), true);
  });
});

describe('pasted image naming (Ctrl+V)', () => {
  it('names an unnamed clipboard blob so the allowlist accepts it', () => {
    const name = pastedImageName('image/png', 1, Date.parse('2026-08-24T10:20:30Z'));
    assert.equal(name, 'pasted-image-20260824T102030-1.png');
    assert.equal(isAllowedAttachmentName(name!), true);
  });

  it('accepts every pasteable image type and keeps them allowlisted', () => {
    for (const [mime, ext] of Object.entries({
      'image/png': '.png',
      'image/jpeg': '.jpg',
      'image/gif': '.gif',
      'image/webp': '.webp',
      'image/bmp': '.bmp',
      'image/tiff': '.tiff',
      'image/svg+xml': '.svg',
    })) {
      const name = pastedImageName(mime, 1, Date.now());
      assert.equal(extensionOf(name!), ext, `${mime} -> ${ext}`);
      assert.equal(isAllowedAttachmentName(name!), true, `${mime} allowlisted`);
    }
  });

  it('tolerates a charset-suffixed type from the clipboard', () => {
    assert.equal(
      extensionOf(pastedImageName('image/PNG; charset=binary', 2, Date.now())!),
      '.png',
    );
  });

  it('refuses to invent a name for a non-image blob', () => {
    assert.equal(pastedImageName('application/zip', 1, Date.now()), null);
    assert.equal(pastedImageName('', 1, Date.now()), null);
    assert.equal(pastedImageName(null, 1, Date.now()), null);
  });

  it('keeps two pastes in the same turn distinguishable', () => {
    const now = Date.now();
    assert.notEqual(pastedImageName('image/png', 1, now), pastedImageName('image/png', 2, now));
  });

  it('produces a name a fresh turn will accept through validateNewAttachments', () => {
    const name = pastedImageName('image/png', 1, Date.now())!;
    const check = validateNewAttachments([], [{ name, size: 1024, type: 'image/png' }]);
    assert.equal(check.ok, true);
  });
});
