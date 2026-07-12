/**
 * F6 basic accessibility + responsive checks (static / pure).
 *
 * No browser: validates that shell CSS + key components expose the
 * responsive breakpoints and a11y attributes required by ADR §18 / Phase 6.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = (...parts: string[]) => join(here, '..', 'src', ...parts);

function readSrc(...parts: string[]): string {
  return readFileSync(src(...parts), 'utf8');
}

describe('F6 responsive layout (CSS breakpoints)', () => {
  const css = readSrc('shared', 'styles', 'app.css');

  it('defines tablet inspector drawer breakpoint (max-width: 1100px)', () => {
    assert.match(css, /@media\s*\(max-width:\s*1100px\)/);
    assert.match(css, /\.context-inspector/);
    assert.match(css, /\.inspector-backdrop/);
  });

  it('defines mobile sidebar drawer breakpoint (max-width: 768px)', () => {
    assert.match(css, /@media\s*\(max-width:\s*768px\)/);
    assert.match(css, /\.sidebar\.open-mobile/);
    assert.match(css, /\.sidebar-backdrop/);
    assert.match(css, /\.sidebar-close-btn/);
  });

  it('keeps three-pane workbench shell classes', () => {
    assert.match(css, /\.workbench-shell|\.app-shell/);
    assert.match(css, /\.main-col/);
  });
});

describe('F6 a11y attributes on key surfaces', () => {
  it('AppShell: live status region + labelled toggles', () => {
    const shell = readSrc('app', 'layout', 'AppShell.tsx');
    assert.match(shell, /aria-label=["']Toggle sidebar["']/);
    assert.match(shell, /aria-live=["']polite["']/);
    assert.match(shell, /aria-label=["']Toggle context inspector["']/);
    assert.match(shell, /aria-pressed=\{inspectorOpen\}/);
  });

  it('ConversationSidebar: primary nav + list semantics', () => {
    const side = readSrc('widgets', 'conversation-sidebar', 'ConversationSidebar.tsx');
    assert.match(side, /aria-label=["']Primary["']/);
    assert.match(side, /role=["']list["']/);
    assert.match(side, /role=["']listitem["']/);
    assert.match(side, /aria-label=["']Close sidebar["']/);
    assert.match(side, /aria-label=["']Delete conversation["']/);
  });

  it('Composer: status banners and running action group', () => {
    const composer = readSrc('widgets', 'composer', 'Composer.tsx');
    assert.match(composer, /role=["']status["']/);
    assert.match(composer, /role=["']group["']/);
    assert.match(composer, /aria-label=["']Running action["']/);
  });

  it('RuntimeTimeline + cards: regions and expand controls', () => {
    const timeline = readSrc('widgets', 'runtime-timeline', 'RuntimeTimeline.tsx');
    assert.match(timeline, /aria-label=["']Runtime activity["']/);

    const tool = readSrc(
      'widgets',
      'runtime-timeline',
      'cards',
      'ToolExecutionCard.tsx',
    );
    assert.match(tool, /aria-expanded=\{open\}/);
    assert.match(tool, /aria-label=\{open \? 'Collapse tool details'/);

    const approval = readSrc(
      'widgets',
      'runtime-timeline',
      'cards',
      'ApprovalCard.tsx',
    );
    assert.match(approval, /role=["']button["']/);
  });

  it('Management pages: tablist filters with aria-selected', () => {
    const runs = readSrc('pages', 'runs', 'RunsPage.tsx');
    assert.match(runs, /role=["']tablist["']/);
    assert.match(runs, /aria-selected=\{filter === f\.id\}/);
    assert.match(runs, /aria-label=["']Run detail["']/);

    const approvals = readSrc('pages', 'approvals', 'ApprovalsPage.tsx');
    assert.match(approvals, /role=["']tablist["']/);
    assert.match(approvals, /aria-selected=\{filter === f\.id\}/);

    const caps = readSrc('pages', 'settings', 'CapabilitiesPage.tsx');
    assert.match(caps, /role=["']tablist["']/);
    assert.match(caps, /aria-selected=\{tab === t\.id\}/);
  });

  it('BudgetBar + ConversationHeader: status/region labels', () => {
    const budget = readSrc('widgets', 'budget-bar', 'BudgetBar.tsx');
    assert.match(budget, /role=["']status["']/);
    assert.match(budget, /aria-label=\{`Budget:/);

    const header = readSrc(
      'widgets',
      'conversation-header',
      'ConversationHeader.tsx',
    );
    assert.match(header, /role=["']region["']/);
    assert.match(header, /aria-label=["']Conversation["']/);
  });

  it('index.html: lang + viewport meta for mobile', () => {
    const html = readFileSync(join(here, '..', 'index.html'), 'utf8');
    assert.match(html, /lang=["']zh-CN["']/);
    assert.match(html, /name=["']viewport["']/);
    assert.match(html, /width=device-width/);
    assert.match(html, /id=["']root["']/);
  });
});

describe('F6 cleanup invariants', () => {
  it('entry is React main.tsx, not vanilla main.js', () => {
    const html = readFileSync(join(here, '..', 'index.html'), 'utf8');
    assert.match(html, /src=["']\/src\/main\.tsx["']/);
    assert.doesNotMatch(html, /main\.js/);
  });

  it('chatState no longer exports message LocalStorage restore', async () => {
    const mod = await import('../src/shared/state/chatState.ts');
    assert.equal(
      'persistMessages' in mod,
      false,
      'persistMessages must be removed',
    );
    assert.equal(
      'loadPersistedMessages' in mod,
      false,
      'loadPersistedMessages must be removed',
    );
    assert.equal(typeof mod.persistConversationId, 'function');
    assert.equal(typeof mod.loadPersistedConversationId, 'function');
    assert.equal(typeof mod.persistSidebarOpen, 'function');
    assert.equal(typeof mod.clearPersistedChat, 'function');
  });
});
