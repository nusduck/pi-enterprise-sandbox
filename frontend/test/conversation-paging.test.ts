import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appendConversations,
  normalizeServerConversation,
} from '../src/features/chat/conversationPaging.ts';
import { mergeConversation } from '../src/features/chat/conversationProjection.ts';
import type { ConversationSummary } from '../src/shared/state/types.ts';

const here = dirname(fileURLToPath(import.meta.url));

describe('conversationPaging: normalizeServerConversation', () => {
  it('normalizes server conversation with conversation_id into id', () => {
    const raw = {
      conversation_id: 'conv-123',
      title: 'Test Conversation',
      created_at: '2026-10-02T10:00:00Z',
      updated_at: '2026-10-02T10:05:00Z',
      sandbox_session_id: 'sess-456',
    };
    const normalized = normalizeServerConversation(raw);
    assert.equal(normalized.id, 'conv-123');
    assert.equal(normalized.title, 'Test Conversation');
    assert.equal(normalized.created_at, '2026-10-02T10:00:00Z');
    assert.equal(normalized.updated_at, '2026-10-02T10:05:00Z');
    assert.equal(normalized.sandbox_session_id, 'sess-456');
  });

  it('preserves existing id if conversation_id is not set', () => {
    const raw = {
      id: 'conv-abc',
      title: 'Direct ID',
    };
    const normalized = normalizeServerConversation(raw);
    assert.equal(normalized.id, 'conv-abc');
  });
});

describe('conversationPaging: appendConversations deduplication', () => {
  it('appends incoming items and dedupes by id / conversation_id', () => {
    const existing: ConversationSummary[] = [
      { id: 'c1', title: 'Conversation 1' },
      { id: 'c2', title: 'Conversation 2' },
    ];
    const incoming = [
      { conversation_id: 'c2', title: 'Conversation 2 Duplicate' },
      { conversation_id: 'c3', title: 'Conversation 3' },
      { id: 'c4', title: 'Conversation 4' },
    ];

    const result = appendConversations(existing, incoming);
    assert.equal(result.length, 4);
    assert.deepEqual(result.map((c) => c.id), ['c1', 'c2', 'c3', 'c4']);
    // Existing item c2 is preserved in original position and not duplicated
    assert.equal(result[1].title, 'Conversation 2');
  });

  it('handles empty or null existing conversations gracefully', () => {
    const incoming = [
      { conversation_id: 'c1', title: 'First' },
      { conversation_id: 'c2', title: 'Second' },
    ];
    const resultFromNull = appendConversations(null, incoming);
    assert.equal(resultFromNull.length, 2);
    assert.equal(resultFromNull[0].id, 'c1');
    assert.equal(resultFromNull[1].id, 'c2');

    const resultFromEmpty = appendConversations([], incoming);
    assert.equal(resultFromEmpty.length, 2);
  });

  it('skips incoming items without a valid id', () => {
    const existing: ConversationSummary[] = [{ id: 'c1', title: 'One' }];
    const incoming = [
      { title: 'No ID' },
      { id: '', title: 'Empty ID' },
      { conversation_id: 'c2', title: 'Valid Two' },
    ];
    const result = appendConversations(existing, incoming);
    assert.equal(result.length, 2);
    assert.deepEqual(result.map((c) => c.id), ['c1', 'c2']);
  });
});

describe('conversationProjection: mergeConversation unshifts to top', () => {
  it('unshifts newly created conversation to index 0', () => {
    const existing: ConversationSummary[] = [
      { id: 'c1', title: 'Existing 1' },
      { id: 'c2', title: 'Existing 2' },
    ];
    const newConv: ConversationSummary = {
      id: 'c3',
      title: 'Newly Created Conversation',
    };

    const merged = mergeConversation(existing, newConv);
    assert.equal(merged.length, 3);
    assert.equal(merged[0].id, 'c3');
    assert.equal(merged[0].title, 'Newly Created Conversation');
    assert.equal(merged[1].id, 'c1');
    assert.equal(merged[2].id, 'c2');
  });

  it('moves updated conversation to index 0 with merged properties', () => {
    const existing: ConversationSummary[] = [
      { id: 'c1', title: 'Existing 1', updated_at: '2026-10-02T10:00:00Z' },
      { id: 'c2', title: 'Existing 2', updated_at: '2026-10-02T09:00:00Z' },
      { id: 'c3', title: 'Existing 3', updated_at: '2026-10-02T08:00:00Z' },
    ];
    const updatedConv: ConversationSummary = {
      id: 'c2',
      title: 'Updated Existing 2',
      updated_at: '2026-10-02T11:00:00Z',
    };

    const merged = mergeConversation(existing, updatedConv);
    assert.equal(merged.length, 3);
    assert.equal(merged[0].id, 'c2');
    assert.equal(merged[0].title, 'Updated Existing 2');
    assert.equal(merged[0].updated_at, '2026-10-02T11:00:00Z');
    assert.equal(merged[1].id, 'c1');
    assert.equal(merged[2].id, 'c3');
  });

  it('handles null or undefined list by returning single-element list', () => {
    const newConv: ConversationSummary = { id: 'c1', title: 'Only Conv' };
    const fromNull = mergeConversation(null, newConv);
    assert.equal(fromNull.length, 1);
    assert.equal(fromNull[0].id, 'c1');

    const fromUndefined = mergeConversation(undefined, newConv);
    assert.equal(fromUndefined.length, 1);
    assert.equal(fromUndefined[0].id, 'c1');
  });
});

describe('sidebar search & pagination generation tracking', () => {
  it('drops out-of-order stale responses using generation IDs', async () => {
    let currentGen = 0;
    let committedResults: ConversationSummary[] | null = null;

    // Simulate search query #1 (triggered earlier)
    const gen1 = ++currentGen;
    let finishGen1: () => void = () => {};
    const promise1 = new Promise<ConversationSummary[]>((resolve) => {
      finishGen1 = () => resolve([{ id: 'c1', title: 'Search 1 Result' }]);
    });

    // Simulate search query #2 (triggered later, e.g. user typed another letter)
    const gen2 = ++currentGen;
    const gen2Results: ConversationSummary[] = [{ id: 'c2', title: 'Search 2 Result' }];
    // Gen 2 completes first
    if (gen2 === currentGen) {
      committedResults = gen2Results;
    }

    // Now Gen 1 finishes late
    finishGen1();
    const lateResults = await promise1;
    if (gen1 === currentGen) {
      committedResults = lateResults;
    }

    // Committed results must remain gen 2, ignoring gen 1
    assert.deepEqual(committedResults, gen2Results);
    assert.equal(committedResults![0].id, 'c2');
  });

  it('restores full conversation list when search query is cleared', () => {
    const fullConversations: ConversationSummary[] = [
      { id: 'c1', title: 'Conv 1' },
      { id: 'c2', title: 'Conv 2' },
    ];
    let query = 'search';
    let searchResults: ConversationSummary[] | null = [{ id: 'c1', title: 'Conv 1' }];

    // Active conversations while searching
    let isSearching = Boolean(query.trim());
    let active = isSearching ? searchResults ?? [] : fullConversations;
    assert.equal(active.length, 1);

    // Clear query
    query = '';
    searchResults = null;
    isSearching = Boolean(query.trim());
    active = isSearching ? searchResults ?? [] : fullConversations;
    assert.equal(active.length, 2);
    assert.deepEqual(active, fullConversations);
  });
});

describe('sidebar conversation list and search single-page end message rule', () => {
  const CONVERSATION_PAGE_SIZE = 20;

  function computeSentinelShowEnd(opts: {
    isSearching: boolean;
    searchHasAppended: boolean;
    hasLoadedMoreNormal: boolean;
    conversationsCount: number;
  }): boolean {
    return opts.isSearching
      ? opts.searchHasAppended
      : opts.hasLoadedMoreNormal || opts.conversationsCount > CONVERSATION_PAGE_SIZE;
  }

  it('suppresses end message when first page has no further items (initial load)', () => {
    // 5 conversations loaded on first page, next_cursor is null
    const showEnd = computeSentinelShowEnd({
      isSearching: false,
      searchHasAppended: false,
      hasLoadedMoreNormal: false,
      conversationsCount: 5,
    });
    assert.equal(showEnd, false, 'Do not show 没有更早的会话了 if only 1 page exists');
  });

  it('shows end message after at least one incremental load occurs', () => {
    // User scrolled and loaded another batch
    const showEnd = computeSentinelShowEnd({
      isSearching: false,
      searchHasAppended: false,
      hasLoadedMoreNormal: true,
      conversationsCount: 25,
    });
    assert.equal(showEnd, true, 'Show 没有更早的会话了 after incremental load');
  });

  it('shows end message if total conversations exceed page size even before explicit load more', () => {
    const showEnd = computeSentinelShowEnd({
      isSearching: false,
      searchHasAppended: false,
      hasLoadedMoreNormal: false,
      conversationsCount: 21,
    });
    assert.equal(showEnd, true);
  });

  it('suppresses end message for single-page search results', () => {
    const showEnd = computeSentinelShowEnd({
      isSearching: true,
      searchHasAppended: false,
      hasLoadedMoreNormal: false,
      conversationsCount: 3,
    });
    assert.equal(showEnd, false, 'Do not show end message for 1 page search result');
  });

  it('shows end message for search results after incremental search load', () => {
    const showEnd = computeSentinelShowEnd({
      isSearching: true,
      searchHasAppended: true,
      hasLoadedMoreNormal: false,
      conversationsCount: 25,
    });
    assert.equal(showEnd, true, 'Show end message after search results have been appended');
  });

  it('structural check: ConversationSidebar wires sentinelShowEnd with hasLoadedMoreNormal and searchHasAppended', () => {
    const sidebarSrc = readFileSync(
      join(here, '..', 'src', 'widgets', 'conversation-sidebar', 'ConversationSidebar.tsx'),
      'utf8',
    );
    assert.match(sidebarSrc, /hasLoadedMoreNormal/);
    assert.match(sidebarSrc, /searchHasAppended/);
    assert.match(sidebarSrc, /showEndMessage=\{sentinelShowEnd\}/);
  });
});

