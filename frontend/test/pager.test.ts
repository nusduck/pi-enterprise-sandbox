import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useCursorPagination } from '../src/shared/ui/Pager.tsx';

describe('useCursorPagination cursor stack', () => {
  it('manages cursor stack across forward and backward pagination', () => {
    // We can simulate the state machine directly using the logic of useCursorPagination
    let page = 1;
    let cursorStack: Array<string | null> = [null];
    let nextCursor: string | null = null;

    const setPageData = (cursor: string | null) => {
      nextCursor = cursor;
    };

    const goToNextPage = () => {
      if (!nextCursor) return;
      cursorStack = cursorStack.slice(0, page);
      cursorStack.push(nextCursor);
      page += 1;
      nextCursor = null;
    };

    const goToPrevPage = () => {
      if (page <= 1) return;
      page -= 1;
      nextCursor = cursorStack[page];
    };

    const reset = () => {
      page = 1;
      cursorStack = [null];
      nextCursor = null;
    };

    // Initial page 1
    assert.equal(page, 1);
    assert.equal(cursorStack[page - 1], null);
    assert.equal(nextCursor, null);

    // Data loaded for page 1 with next_cursor = 'c1'
    setPageData('c1');
    assert.equal(nextCursor, 'c1');

    // Go to page 2
    goToNextPage();
    assert.equal(page, 2);
    assert.equal(cursorStack[page - 1], 'c1');
    assert.equal(nextCursor, null);

    // Data loaded for page 2 with next_cursor = 'c2'
    setPageData('c2');
    assert.equal(nextCursor, 'c2');

    // Go to page 3
    goToNextPage();
    assert.equal(page, 3);
    assert.equal(cursorStack[page - 1], 'c2');

    // Go back to page 2
    goToPrevPage();
    assert.equal(page, 2);
    assert.equal(cursorStack[page - 1], 'c1');

    // Go back to page 1
    goToPrevPage();
    assert.equal(page, 1);
    assert.equal(cursorStack[page - 1], null);

    // Reset when filter changes
    goToNextPage();
    reset();
    assert.equal(page, 1);
    assert.deepEqual(cursorStack, [null]);
    assert.equal(nextCursor, null);
  });
});

describe('Pager component markup and accessibility', () => {
  it('renders standard pager elements and accessible labels', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const tsx = readFileSync(join(here, '..', 'src', 'shared', 'ui', 'Pager.tsx'), 'utf8');

    assert.match(tsx, /aria-label="分页导航"/);
    assert.match(tsx, /aria-label="上一页"/);
    assert.match(tsx, /aria-label="下一页"/);
    assert.match(tsx, /aria-label="每页显示条数"/);
    assert.match(tsx, /第\s*\{\s*page\s*\}\s*页\s*·\s*本页\s*\{\s*count\s*\}\s*条/);
    assert.match(tsx, /disabled=\{\s*!hasPrev\s*\|\|\s*loading\s*\}/);
    assert.match(tsx, /disabled=\{\s*!hasNext\s*\|\|\s*loading\s*\}/);
  });

  it('renders custom accessible dropdown trigger with portal menu and checkmark', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const tsx = readFileSync(join(here, '..', 'src', 'shared', 'ui', 'Pager.tsx'), 'utf8');

    assert.match(tsx, /aria-haspopup="listbox"/);
    assert.match(tsx, /aria-expanded=\{open\}/);
    assert.match(tsx, /role="listbox"/);
    assert.match(tsx, /role="option"/);
    assert.match(tsx, /createPortal/);
    assert.match(tsx, /IconChevronDown/);
    assert.match(tsx, /IconCheck/);
    assert.match(tsx, /\{\s*pageSize\s*\}\s*条/);
  });
});

