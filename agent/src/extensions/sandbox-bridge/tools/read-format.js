/**
 * Model-facing formatting for sandbox read/exec results.
 *
 * Gutter rendering, line/char budgets, the exec stream envelope, and the
 * content fingerprint the read dedup keys on. Pure string work — no transport,
 * no tool registration.
 */

import { createHash } from 'node:crypto';
import { truncateLine } from '@earendil-works/pi-coding-agent';
import {
  DEFAULT_READ_LIMIT,
  LARGE_FILE_HINT_BYTES,
  MAX_EXEC_RESULT_BYTES,
  MAX_EXEC_STREAM_BYTES,
  MAX_EXEC_STREAM_LINES,
  MAX_READ_BYTES,
  MAX_READ_CHARS,
  MAX_READ_LIMIT,
  MAX_READ_LINE_LENGTH,
} from '../constants.js';
import {
  DEFAULT_TOOL_OUTPUT_LINES,
  truncateToCharBudget,
  truncateToolOutput,
} from '../result.js';

/** Majority of non-empty lines look like read-tool gutters (`12|...`). */
const READ_GUTTER_LINE_RE = /^(\d+)\|/;

/**
 * True when content is dominated by read-tool gutters (`12|...`).
 *
 * A leading-digit-then-pipe prefix alone is not enough: legitimate content
 * can look like that too (a pipe-delimited export with a leading id column,
 * a numbered log). What real gutter output ({@link formatReadContentWithGutter})
 * never varies is the numbering itself — consecutive matched lines are
 * consecutive integers, because it is always `offset + i + 1`. Requiring that
 * run keeps the check from refusing a write/edit over content that merely
 * starts lines with a number.
 * @param {string} content
 */
export function looksLikeReadFileGutterContent(content) {
  const text = String(content ?? '');
  if (!text.trim()) return false;
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length < 2) return false;
  /** @type {number[]} */
  const numbers = [];
  for (const line of lines) {
    const m = READ_GUTTER_LINE_RE.exec(line);
    if (m) numbers.push(Number(m[1]));
  }
  if (numbers.length / lines.length < 0.7) return false;
  if (numbers.length < 2) return false;
  let consecutive = 0;
  for (let i = 1; i < numbers.length; i += 1) {
    if (numbers[i] === numbers[i - 1] + 1) consecutive += 1;
  }
  return consecutive / (numbers.length - 1) >= 0.9;
}

/**
 * Hermes/Pi-aligned exec stream bounding for bash/python.
 * @param {any} data
 * @param {{ extras?: Record<string, unknown> }} [opts]
 */
export function formatExecStreams(data, opts = {}) {
  const stdout = truncateToolOutput(data?.stdout ?? '', {
    maxBytes: MAX_EXEC_STREAM_BYTES,
    maxLines: MAX_EXEC_STREAM_LINES,
  });
  const stderr = truncateToolOutput(data?.stderr ?? '', {
    maxBytes: MAX_EXEC_STREAM_BYTES,
    maxLines: MAX_EXEC_STREAM_LINES,
  });
  /** @type {Record<string, unknown>} */
  const payload = {
    exitCode: data?.exitCode ?? data?.exit_code ?? null,
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    stdoutTruncatedBy: stdout.truncatedBy,
    stderrTruncatedBy: stderr.truncatedBy,
    stdoutTotalBytes: stdout.totalBytes,
    stderrTotalBytes: stderr.totalBytes,
    stdoutTotalLines: stdout.totalLines,
    stderrTotalLines: stderr.totalLines,
    stdoutOutputLines: stdout.outputLines,
    stderrOutputLines: stderr.outputLines,
  };
  if (stdout.truncated) {
    payload.stdoutContinuation =
      `stdout truncated by ${stdout.truncatedBy} (showing ${stdout.outputLines}/${stdout.totalLines} lines, ${stdout.outputBytes}/${stdout.totalBytes} bytes). Re-run with a narrower command (head/tail/rg).`;
  }
  if (stderr.truncated) {
    payload.stderrContinuation =
      `stderr truncated by ${stderr.truncatedBy} (showing ${stderr.outputLines}/${stderr.totalLines} lines). Re-run with a narrower command.`;
  }
  if (opts.extras && typeof opts.extras === 'object') {
    Object.assign(payload, opts.extras);
  }
  return payload;
}

/**
 * Compact gutter `LINE_NUM|CONTENT` (Hermes / Pi style). Line numbers are
 * 1-based file coordinates: page start at 0-based `offset` → first line is
 * `offset + 1`.
 *
 * @param {string} source
 * @param {number} offset0
 * @param {number} maxLineLength
 * @returns {string}
 */
export function formatReadContentWithGutter(source, offset0, maxLineLength = MAX_READ_LINE_LENGTH) {
  const text = String(source ?? '');
  if (!text) return '';
  const lines = text.split('\n');
  const start = Math.max(0, Number(offset0) || 0);
  const maxLen = Math.max(1, Number(maxLineLength) || MAX_READ_LINE_LENGTH);
  /** @type {string[]} */
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    // Pi's own per-line clamp, so an over-wide line is marked the same way the
    // model sees it from every other Pi tool.
    const { text: line } = truncateLine(lines[i], maxLen);
    out.push(`${start + i + 1}|${line}`);
  }
  return out.join('\n');
}

/**
 * Stable fingerprint for dedup. Hashes the *whole* rendered page, not just
 * its head/tail: a same-length edit in the middle of a page (a script run
 * through bash/python touching a file the read/edit tool did not itself
 * write, so the dedup cache was never invalidated for that path) must still
 * change the fingerprint, or a re-read would wrongly get stubbed as
 * "unchanged" and the model would reason from stale content.
 * @param {string} content
 * @param {unknown} size
 */
export function readContentFingerprint(content, size) {
  const text = String(content ?? '');
  const hash = createHash('sha1').update(text, 'utf8').digest('hex');
  return `${size ?? ''}|${text.length}|${hash}`;
}

/**
 * Build model-facing read payload (Hermes-aligned gutters + char budget).
 * @param {any} data
 * @param {string} path
 * @param {number} requestOffset
 * @param {number} requestLimit
 */
export function formatReadResult(data, path, requestOffset = 0, requestLimit = DEFAULT_READ_LIMIT) {
  if (data?.binary || data?.isBinary) {
    return {
      payload: {
        path,
        binary: true,
        size: data.size ?? null,
        mimeType: data.mimeType ?? null,
      },
      fingerprint: `binary:${data?.size ?? ''}:${data?.mimeType ?? ''}`,
    };
  }

  const offset = Math.max(
    0,
    Number(data?.offset ?? requestOffset ?? 0) || 0,
  );
  const limit =
    data?.limit != null
      ? Number(data.limit)
      : requestLimit;
  const source = String(data?.content ?? data?.text ?? '');
  const guttered = formatReadContentWithGutter(
    source,
    offset,
    MAX_READ_LINE_LENGTH,
  );

  // Line-count cap first (Hermes max_lines / Pi DEFAULT_MAX_LINES).
  const lineBound = truncateToolOutput(guttered, {
    maxBytes: Number.MAX_SAFE_INTEGER,
    maxLines: DEFAULT_TOOL_OUTPUT_LINES,
  });
  let bodyText = lineBound.text;
  let linesKept = lineBound.completedLines;
  let truncated = lineBound.truncated || Boolean(data?.truncated);
  /** @type {string | null} */
  let truncatedBy = lineBound.truncated ? lineBound.truncatedBy : null;
  let partialLine = Boolean(lineBound.partialLine);

  // Character budget (Hermes file_read_max_chars) — whole lines only.
  const charBound = truncateToCharBudget(bodyText, MAX_READ_CHARS);
  if (charBound.truncated) {
    bodyText = charBound.text;
    linesKept = charBound.partialLine ? 0 : charBound.linesKept;
    truncated = true;
    truncatedBy = 'chars';
    partialLine = charBound.partialLine;
  }

  // Bridge-side bounds override the sandbox cursor so we never skip unread
  // lines from a partially-rendered page.
  const bridgeTruncated =
    lineBound.truncated || charBound.truncated || partialLine;
  const nextOffset = bridgeTruncated
    ? offset + linesKept
    : data?.nextOffset ??
      data?.next_offset ??
      (data?.truncated ? offset + linesKept : null);

  /** @type {string | undefined} */
  let continuation;
  if (truncated) {
    if (partialLine && linesKept === 0) {
      continuation =
        'Read output is truncated inside the first line; use a narrower range or Python to inspect that line.';
    } else if (nextOffset != null) {
      const shownEnd = offset + Math.max(linesKept, 1);
      continuation =
        `Showing lines ${offset + 1}-${shownEnd}` +
        (truncatedBy ? ` (truncated by ${truncatedBy})` : '') +
        `. Continue with offset=${nextOffset}.`;
    } else {
      continuation = 'Read output is truncated.';
    }
  }

  const size =
    data?.size != null && Number.isFinite(Number(data.size))
      ? Number(data.size)
      : null;
  /** @type {string | undefined} */
  let hint;
  if (
    size != null &&
    size > LARGE_FILE_HINT_BYTES &&
    (limit == null || limit > 200)
  ) {
    hint =
      'Large file: prefer targeted offset/limit ranges or a section map before reading the whole document.';
  }

  const payload = {
    path,
    content: bodyText,
    truncated,
    truncatedBy,
    totalBytes: Buffer.byteLength(source, 'utf8'),
    totalLines: lineBound.totalLines,
    offset,
    limit: limit ?? null,
    size,
    nextOffset,
    ...(continuation ? { continuation } : {}),
    ...(hint ? { hint } : {}),
  };

  return {
    payload,
    fingerprint: readContentFingerprint(bodyText, size),
  };
}
