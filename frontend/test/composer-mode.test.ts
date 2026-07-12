/**
 * F4 Composer mode switching + resume entry helpers.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  canFollowUp,
  canSteer,
  canStop,
  composerModeLabel,
  composerPlaceholder,
  resolveComposerMode,
  runningActionHint,
  shouldShowResumeEntry,
} from '../src/widgets/composer/composerMode.ts';

describe('resolveComposerMode', () => {
  it('returns idle when not streaming and no run', () => {
    assert.equal(resolveComposerMode({}), 'idle');
    assert.equal(
      resolveComposerMode({ isStreaming: false, runStatus: 'succeeded' }),
      'idle',
    );
    assert.equal(
      resolveComposerMode({ isStreaming: false, runStatus: 'failed' }),
      'idle',
    );
  });

  it('returns running when streaming or active run status', () => {
    assert.equal(resolveComposerMode({ isStreaming: true }), 'running');
    assert.equal(
      resolveComposerMode({ runStatus: 'running' }),
      'running',
    );
    assert.equal(
      resolveComposerMode({ runStatus: 'queued' }),
      'running',
    );
    assert.equal(
      resolveComposerMode({ runStatus: 'restoring_session' }),
      'running',
    );
    assert.equal(
      resolveComposerMode({ runStatus: 'cancel_requested' }),
      'running',
    );
  });

  it('returns waiting_approval with priority over running', () => {
    assert.equal(
      resolveComposerMode({
        isStreaming: true,
        runStatus: 'running',
        hasPendingApproval: true,
      }),
      'waiting_approval',
    );
    assert.equal(
      resolveComposerMode({ runStatus: 'waiting_approval' }),
      'waiting_approval',
    );
  });
});

describe('composer mode helpers', () => {
  it('labels and placeholders cover all modes', () => {
    assert.equal(composerModeLabel('idle'), 'New task');
    assert.equal(composerModeLabel('running'), 'Agent running');
    assert.equal(composerModeLabel('waiting_approval'), 'Waiting approval');

    assert.match(composerPlaceholder('idle'), /message/i);
    assert.match(composerPlaceholder('running', 'steer'), /Steer/i);
    assert.match(composerPlaceholder('running', 'follow_up'), /Follow-up/i);
    assert.match(composerPlaceholder('waiting_approval'), /approve/i);
  });

  it('runningActionHint distinguishes steer vs follow-up', () => {
    assert.match(runningActionHint('steer'), /direction/i);
    assert.match(runningActionHint('follow_up'), /after/i);
  });

  it('capability flags for modes', () => {
    assert.equal(canSteer('running', 'running'), true);
    assert.equal(canSteer('running', 'cancel_requested'), false);
    assert.equal(canSteer('idle'), false);
    assert.equal(canFollowUp('running'), true);
    assert.equal(canFollowUp('waiting_approval'), true);
    assert.equal(canFollowUp('idle'), false);
    assert.equal(canStop('running'), true);
    assert.equal(canStop('waiting_approval'), true);
    assert.equal(canStop('idle'), false);
  });
});

describe('shouldShowResumeEntry', () => {
  it('shows for interrupted run or last interrupted message', () => {
    assert.equal(
      shouldShowResumeEntry({ runStatus: 'interrupted' }),
      true,
    );
    assert.equal(
      shouldShowResumeEntry({ lastMessageInterrupted: true }),
      true,
    );
  });

  it('hides while streaming or when clean idle', () => {
    assert.equal(
      shouldShowResumeEntry({
        runStatus: 'interrupted',
        isStreaming: true,
      }),
      false,
    );
    assert.equal(
      shouldShowResumeEntry({ runStatus: 'succeeded' }),
      false,
    );
    assert.equal(shouldShowResumeEntry({}), false);
  });
});
