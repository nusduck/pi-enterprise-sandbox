/**
 * Hermes-style read dedup for one run's tool bundle.
 *
 * Re-reading an unchanged region burns context and is usually a model loop, so
 * the first repeat returns a stub and the second is refused outright. State is
 * per bundle instance — created with the tools, discarded with them — and a
 * write/edit to a path drops that path's entries so the next read is honest.
 */

import { MAX_READ_CHARS, MAX_READ_IMAGE_BYTES } from '../constants.js';
import { toolErr, toolOk, toolResultJson } from '../result.js';
import { formatReadResult } from './read-format.js';
import { buildReadImageResult } from './read-image.js';

/** JSON envelope budget for read — content is pre-bounded to MAX_READ_CHARS. */
const MAX_READ_RESULT_BYTES = MAX_READ_CHARS + 8 * 1024;
/** Hermes-style soft block after repeated identical read pages in one run. */
const READ_DEDUP_SOFT_HITS = 1;
const READ_DEDUP_HARD_HITS = 2;

export function createReadDedup() {
  /**
   * Hermes-style read dedup within one run/tool-bundle instance.
   * Key: path + offset + limit → { fingerprint, hits }.
   * Soft-hit returns a stub (saves context); hard-hit blocks loops.
   * @type {Map<string, { fingerprint: string, hits: number }>}
   */
  const readDedup = new Map();
  /**
   * @param {string} path
   * @param {number} offset
   * @param {number} limit
   * @param {string} fingerprint
   * @returns {{ action: 'proceed' } | { action: 'stub' | 'block', hits: number }}
   */
  function noteReadDedup(path, offset, limit, fingerprint) {
    const key = `${path}\0${offset}\0${limit}`;
    const prev = readDedup.get(key);
    if (!prev || prev.fingerprint !== fingerprint) {
      readDedup.set(key, { fingerprint, hits: 0 });
      // Cap map growth on pathological agents.
      if (readDedup.size > 256) {
        const first = readDedup.keys().next().value;
        if (first != null) readDedup.delete(first);
      }
      return { action: 'proceed' };
    }
    const hits = prev.hits + 1;
    prev.hits = hits;
    if (hits >= READ_DEDUP_HARD_HITS) {
      return { action: 'block', hits: hits + 1 };
    }
    if (hits >= READ_DEDUP_SOFT_HITS) {
      return { action: 'stub', hits: hits + 1 };
    }
    return { action: 'proceed' };
  }

  /** After write/edit, cached read pages for that path are stale. */
  function invalidateReadDedupForPath(path) {
    const prefix = `${path}\0`;
    for (const key of readDedup.keys()) {
      if (key.startsWith(prefix)) readDedup.delete(key);
    }
  }

  /**
   * Format + Hermes-style dedup for model-facing read results.
   * @param {any} data
   * @param {string} path
   * @param {number} offset
   * @param {number} limit
   * @param {{ model?: object | null }} [opts] current model, for the vision check
   */
  async function finalizeReadResult(data, path, offset, limit, opts = {}) {
    const { payload, fingerprint } = formatReadResult(
      data,
      path,
      offset,
      limit,
    );
    if (payload.binary) {
      // Dedup deliberately does not apply: an image result is content the model
      // is looking at, and a stub in its place would blind a legitimate re-read.
      const image = await buildReadImageResult(data, path, {
        model: opts.model ?? null,
        maxBytes: MAX_READ_IMAGE_BYTES,
      });
      if (image) return image;
      return toolOk(toolResultJson(payload, MAX_READ_RESULT_BYTES));
    }
    const dedup = noteReadDedup(path, offset, limit, fingerprint);
    if (dedup.action === 'block') {
      return toolErr(
        'READ_DEDUP_BLOCKED',
        `You have re-read this exact region ${dedup.hits} times and the content has not changed. Stop re-reading; use the earlier read_file result and proceed.`,
        { path, offset, limit, alreadyRead: dedup.hits },
      );
    }
    if (dedup.action === 'stub') {
      return toolOk(
        toolResultJson(
          {
            status: 'unchanged',
            path,
            offset,
            limit,
            dedup: true,
            content_returned: false,
            message:
              'File region unchanged since the last identical read in this run. Reuse the earlier content instead of re-reading.',
          },
          MAX_READ_RESULT_BYTES,
        ),
      );
    }
    return toolOk(toolResultJson(payload, MAX_READ_RESULT_BYTES));
  }

  return { finalizeReadResult, invalidateReadDedupForPath };
}
