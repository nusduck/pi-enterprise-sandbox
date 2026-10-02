import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveSentinelState } from '../src/shared/ui/loadMoreSentinelState.ts';

const here = dirname(fileURLToPath(import.meta.url));
const readSrc = (...parts: string[]) => readFileSync(join(here, '..', 'src', ...parts), 'utf8');

describe('LoadMoreSentinel three states resolution', () => {
  it('resolves error state with precedence over loading and end states', () => {
    const state = resolveSentinelState({
      loading: true,
      hasMore: false,
      error: '网络连接超时',
    });
    assert.equal(state, 'error');
  });

  it('resolves loading state when loading is true and no error', () => {
    const state = resolveSentinelState({
      loading: true,
      hasMore: true,
      error: null,
    });
    assert.equal(state, 'loading');
  });

  it('resolves end state when hasMore is false and not loading', () => {
    const state = resolveSentinelState({
      loading: false,
      hasMore: false,
      error: null,
      showEndMessage: true,
    });
    assert.equal(state, 'end');
  });

  it('resolves idle when hasMore is true, not loading, and no error', () => {
    const state = resolveSentinelState({
      loading: false,
      hasMore: true,
      error: null,
    });
    assert.equal(state, 'idle');
  });

  it('supports hiding end message when showEndMessage is false', () => {
    const state = resolveSentinelState({
      loading: false,
      hasMore: false,
      showEndMessage: false,
    });
    assert.equal(state, 'idle');
  });
});

describe('LoadMoreSentinel component structure & a11y', () => {
  const tsx = readSrc('shared', 'ui', 'LoadMoreSentinel.tsx');
  const css = readSrc('shared', 'ui', 'loadMoreSentinel.module.css');

  it('exposes a11y roles for alert and status', () => {
    assert.match(tsx, /role="alert"/);
    assert.match(tsx, /role="status"/);
    assert.match(tsx, /aria-hidden="true"/);
  });

  it('uses IntersectionObserver with default 200px rootMargin', () => {
    assert.match(tsx, /rootMargin\s*=\s*['"]200px['"]/);
    assert.match(tsx, /new IntersectionObserver/);
    assert.match(tsx, /observer\.disconnect/);
  });

  it('includes proper tail state styles and spinner animation', () => {
    assert.match(css, /\.loading/);
    assert.match(css, /\.error/);
    assert.match(css, /\.end/);
    assert.match(css, /@keyframes spin/);
  });

  it('skips observer and returns null when idle without more items (e.g. single page)', () => {
    assert.match(tsx, /if\s*\(state\s*===\s*'idle'\s*&&\s*!hasMore\)\s*\{\s*return\s+null;\s*\}/);
    assert.match(tsx, /if\s*\(state\s*!==\s*'idle'\s*\|\|\s*!hasMore\)\s*return;/);
  });
});
