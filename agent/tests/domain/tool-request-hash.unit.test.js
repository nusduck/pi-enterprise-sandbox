/**
 * PR-07B batch 2A1: Node unit tests for tool request-hash v1.
 * Consumes the shared golden fixture under tests/fixtures/contracts/.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TOOL_REQUEST_HASH_VERSION,
  TOOL_NAME_MAX_LEN,
  ToolRequestHashError,
  assertToolRequestToolName,
  canonicalToolRequestJsonV1,
  computeToolRequestHashV1,
} from '../../src/domain/tool/tool-request-hash.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// agent/tests/domain → repo root is ../../../
const FIXTURE_PATH = path.join(
  __dirname,
  '../../../tests/fixtures/contracts/sandbox-tool-request-hash-v1.json',
);

/**
 * @param {unknown} node
 * @returns {unknown}
 */
function materializeValue(node) {
  if (node === null || typeof node !== 'object') return node;
  const n = /** @type {Record<string, unknown>} */ (node);
  if (n.kind === 'float') {
    // Node cannot distinguish float 1.0 from int 1; non-integral decimals only.
    const dec = n.decimal != null ? Number(n.decimal) : Number(n.value);
    if (!Number.isFinite(dec)) {
      throw new Error(`bad float construct: ${JSON.stringify(n)}`);
    }
    if (Number.isInteger(dec)) {
      // Force a true non-integer so float rejection path is exercised when
      // languages includes node; python-only vectors skip via languages gate.
      return dec + 0.5;
    }
    return dec;
  }
  if (n.kind === 'intString') {
    return Number(/** @type {string} */ (n.value));
  }
  if (n.kind === 'utf16CodeUnits') {
    const units = /** @type {number[]} */ (n.units);
    return String.fromCharCode(...units);
  }
  if (n.kind === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const e of /** @type {Array<{key: string, value: unknown}>} */ (
      n.entries
    )) {
      out[e.key] = materializeValue(e.value);
    }
    return out;
  }
  return node;
}

/**
 * @param {Record<string, unknown>} row
 * @returns {{ toolName: string, args: unknown }}
 */
function materializeInput(row) {
  let toolName = /** @type {string} */ (row.tool ?? '');
  if (row.toolConstruct) {
    const tc = /** @type {Record<string, unknown>} */ (row.toolConstruct);
    if (tc.kind === 'repeat') {
      toolName = String(tc.char).repeat(Number(tc.count));
    }
  }
  let args = row.args !== undefined ? row.args : {};
  if (row.argsConstruct) {
    args = materializeValue(row.argsConstruct);
  }
  return { toolName, args };
}

/**
 * @param {Record<string, unknown>} row
 * @param {string} lang
 */
function appliesToLanguage(row, lang) {
  const langs = row.languages;
  if (!Array.isArray(langs) || langs.length === 0) return true;
  return langs.includes(lang);
}

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));

describe('tool-request-hash v1 (fixture)', () => {
  it('loads shared golden fixture', () => {
    assert.equal(fixture.version, 1);
    assert.equal(fixture.contract, 'sandbox-tool-request-hash-v1');
    assert.ok(Array.isArray(fixture.valid) && fixture.valid.length >= 8);
    assert.ok(Array.isArray(fixture.invalid) && fixture.invalid.length >= 5);
  });

  for (const row of fixture.valid) {
    it(`valid vector ${row.id} matches canonicalJson + requestHash`, () => {
      const { toolName, args } = materializeInput(row);
      const out = computeToolRequestHashV1({ toolName, args });
      assert.equal(out.canonicalJson, row.canonicalJson);
      assert.equal(out.requestHash, row.requestHash);
      assert.equal(out.requestHashVersion, TOOL_REQUEST_HASH_VERSION);
      assert.match(out.requestHash, /^[0-9a-f]{64}$/);
      assert.equal(
        canonicalToolRequestJsonV1({ toolName, args }),
        row.canonicalJson,
      );
    });
  }

  it('composed and decomposed Unicode produce different hashes (no normalization)', () => {
    const composed = fixture.valid.find((v) => v.id === 'unicode-composed');
    const decomposed = fixture.valid.find((v) => v.id === 'unicode-decomposed');
    assert.ok(composed && decomposed);
    assert.notEqual(composed.requestHash, decomposed.requestHash);
    assert.notEqual(composed.canonicalJson, decomposed.canonicalJson);
  });

  for (const row of fixture.invalid) {
    it(`invalid vector ${row.id} rejects`, () => {
      if (!appliesToLanguage(row, 'node')) {
        assert.ok(true, `skipped for node: ${row.id}`);
        return;
      }
      const { toolName, args } = materializeInput(row);
      assert.throws(
        () => computeToolRequestHashV1({ toolName, args }),
        (err) =>
          err instanceof ToolRequestHashError &&
          (row.errorCode == null || err.code === row.errorCode),
      );
    });
  }
});

describe('tool-request-hash v1 (node platform rejects)', () => {
  it('rejects BigInt, Date, Buffer, undefined, function, symbol, cycle', () => {
    assert.throws(
      () => computeToolRequestHashV1({ toolName: 't', args: { x: 1n } }),
      ToolRequestHashError,
    );
    assert.throws(
      () =>
        computeToolRequestHashV1({ toolName: 't', args: { x: new Date() } }),
      ToolRequestHashError,
    );
    assert.throws(
      () =>
        computeToolRequestHashV1({
          toolName: 't',
          args: { x: Buffer.from('ab') },
        }),
      ToolRequestHashError,
    );
    assert.throws(
      () =>
        computeToolRequestHashV1({ toolName: 't', args: { x: undefined } }),
      ToolRequestHashError,
    );
    assert.throws(
      () =>
        computeToolRequestHashV1({
          toolName: 't',
          args: { x: () => {} },
        }),
      ToolRequestHashError,
    );
    assert.throws(
      () =>
        computeToolRequestHashV1({
          toolName: 't',
          args: { x: Symbol('s') },
        }),
      ToolRequestHashError,
    );
    /** @type {Record<string, unknown>} */
    const cycle = { a: 1 };
    cycle.self = cycle;
    assert.throws(
      () => computeToolRequestHashV1({ toolName: 't', args: cycle }),
      (err) =>
        err instanceof ToolRequestHashError &&
        err.code === 'TOOL_REQUEST_HASH_CYCLE',
    );
  });

  it('rejects custom class instances', () => {
    class Foo {
      constructor() {
        this.a = 1;
      }
    }
    assert.throws(
      () => computeToolRequestHashV1({ toolName: 't', args: new Foo() }),
      ToolRequestHashError,
    );
  });

  it('accepts Object.create(null) plain objects', () => {
    const o = Object.create(null);
    o.b = 2;
    o.a = 1;
    const out = computeToolRequestHashV1({ toolName: 't', args: o });
    assert.equal(out.canonicalJson, '{"args":{"a":1,"b":2},"tool":"t","v":1}');
  });

  it('assertToolRequestToolName enforces trim/empty/max', () => {
    assert.equal(assertToolRequestToolName('bash'), 'bash');
    assert.throws(() => assertToolRequestToolName(''), ToolRequestHashError);
    assert.throws(() => assertToolRequestToolName(' x '), ToolRequestHashError);
    assert.throws(
      () => assertToolRequestToolName('a'.repeat(TOOL_NAME_MAX_LEN + 1)),
      ToolRequestHashError,
    );
  });

  it('defaults missing args to {}', () => {
    const out = computeToolRequestHashV1({ toolName: 'bash' });
    assert.equal(out.canonicalJson, '{"args":{},"tool":"bash","v":1}');
  });

  it('explicit args null is canonical null (distinct from omitted {})', () => {
    const nullArgs = computeToolRequestHashV1({ toolName: 'bash', args: null });
    assert.equal(nullArgs.canonicalJson, '{"args":null,"tool":"bash","v":1}');
    assert.equal(
      nullArgs.requestHash,
      '64a85af070139b4b469c22f2489bde65f5659f3f7a1c14a4cfb78d3de028c79c',
    );
    const omitted = computeToolRequestHashV1({ toolName: 'bash' });
    assert.notEqual(nullArgs.requestHash, omitted.requestHash);
  });
});
