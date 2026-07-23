import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  INTERNAL_TOKEN_AUDIENCE,
  INTERNAL_TOKEN_CLAIM_KEYS,
  INTERNAL_TOKEN_DEFAULT_TTL_SECONDS,
  INTERNAL_TOKEN_HEADER_KEYS,
  INTERNAL_TOKEN_ISSUER,
  INTERNAL_TOKEN_SUBJECT,
  INTERNAL_TOKEN_TYPE,
  InternalHmacError,
  issueInternalToken,
  signInternalToken,
  validateInternalHmacKeyring,
  validateInternalTokenClaims,
  verifyInternalToken,
} from '../../src/infrastructure/sandbox/internal-hmac.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// agent/tests/infrastructure → repo root is ../../../
const GOLDEN_FIXTURE_PATH = path.join(
  __dirname,
  '../../../tests/fixtures/contracts/agent-sandbox-internal-hmac-hs256-v1.json',
);

const KEY_BYTES = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
const OTHER_KEY_BYTES = Buffer.from(
  Array.from({ length: 32 }, (_, index) => 255 - index),
);
const KEY = KEY_BYTES.toString('base64url');
const OTHER_KEY = OTHER_KEY_BYTES.toString('base64url');
const KEYRING = Object.freeze({ '2026-07': KEY, previous: OTHER_KEY });
const NOW = 1_700_000_000;
const RANDOM_128 = Uint8Array.from(
  Array.from({ length: 16 }, (_, index) => index),
);

const ISSUE_CLAIMS = Object.freeze({
  org_id: '01K0G2PAV8FPMVC9QHJG7JPN4Z',
  user_id: '01K0G2PAV8FPMVC9QHJG7JPN50',
  conversation_id: '01K0G2PAV8FPMVC9QHJG7JPN51',
  agent_session_id: '01K0G2PAV8FPMVC9QHJG7JPN52',
  sandbox_session_id: '01K0G2PAV8FPMVC9QHJG7JPN5F',
  run_id: '01K0G2PAV8FPMVC9QHJG7JPN5H',
  tool_execution_id: '01K0G2PAV8FPMVC9QHJG7JPN5K',
  tool_call_id: 'tool-call-7',
  tool_name: 'sandbox_bash',
  scope: Object.freeze(['execute:command']),
  request_hash: 'a'.repeat(64),
  execution_fence_token: 7,
  trace_id: 'b'.repeat(32),
  htm: 'POST',
  htu: '/internal/v1/executions/bash',
  body_sha256: 'c'.repeat(64),
});

function issue(overrides = {}, options = {}) {
  return issueInternalToken({
    keyring: KEYRING,
    activeKid: '2026-07',
    claims: { ...ISSUE_CLAIMS, ...overrides },
    clock: () => NOW,
    randomBytes: (size) => {
      assert.equal(size, 16);
      return RANDOM_128;
    },
    ...options,
  });
}

function fullClaims(overrides = {}) {
  return {
    token_version: 1,
    iss: INTERNAL_TOKEN_ISSUER,
    aud: INTERNAL_TOKEN_AUDIENCE,
    sub: INTERNAL_TOKEN_SUBJECT,
    ...ISSUE_CLAIMS,
    request_hash_version: 1,
    iat: NOW,
    nbf: NOW,
    exp: NOW + 60,
    jti: Buffer.from(RANDOM_128).toString('base64url'),
    ...overrides,
  };
}

function decodeJsonSegment(segment) {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

function rawSignedToken(header, claims, key = KEY_BYTES) {
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString(
    'base64url',
  );
  const encodedClaims = Buffer.from(JSON.stringify(claims)).toString(
    'base64url',
  );
  const input = `${encodedHeader}.${encodedClaims}`;
  const signature = createHmac('sha256', key)
    .update(input, 'ascii')
    .digest('base64url');
  return `${input}.${signature}`;
}

function expectCode(fn, code) {
  assert.throws(
    fn,
    (error) => error instanceof InternalHmacError && error.code === code,
  );
}

describe('strict Agent -> Sandbox HS256 internal token', () => {
  it('issues a deterministic compact token and verifies its exact schema', () => {
    const token = issue();
    assert.equal(token, issue());

    const segments = token.split('.');
    assert.equal(segments.length, 3);
    assert.ok(segments.every((segment) => /^[A-Za-z0-9_-]+$/.test(segment)));
    assert.equal(
      segments[2],
      'diyes_cQdwKp6UyrAxN-Wphy2fMhLCY_ckQXIL4nAsU',
    );

    const header = decodeJsonSegment(segments[0]);
    const claims = decodeJsonSegment(segments[1]);
    assert.deepEqual(Object.keys(header), INTERNAL_TOKEN_HEADER_KEYS);
    assert.deepEqual(header, {
      alg: 'HS256',
      kid: '2026-07',
      typ: INTERNAL_TOKEN_TYPE,
    });
    assert.deepEqual(Object.keys(claims), INTERNAL_TOKEN_CLAIM_KEYS);
    assert.equal(claims.iat, NOW);
    assert.equal(claims.nbf, NOW);
    assert.equal(claims.exp, NOW + INTERNAL_TOKEN_DEFAULT_TTL_SECONDS);
    assert.equal(claims.sub, 'agent-worker');
    assert.equal(claims.jti, 'AAECAwQFBgcICQoLDA0ODw');
    assert.equal(Buffer.from(claims.jti, 'base64url').length, 16);

    const verified = verifyInternalToken(token, {
      keyring: KEYRING,
      clock: () => NOW,
    });
    assert.deepEqual(verified, claims);
    assert.ok(Object.isFrozen(verified));
    assert.ok(Object.isFrozen(verified.scope));
  });

  it('accepts object or JSON-string keyrings and requires an existing active kid', () => {
    assert.deepEqual(validateInternalHmacKeyring(KEYRING, '2026-07'), {
      activeKid: '2026-07',
      kids: ['2026-07', 'previous'],
    });
    const json = `{\n  "2026-07": "${KEY}",\n  "previous": "${OTHER_KEY}"\n}`;
    assert.deepEqual(validateInternalHmacKeyring(json, 'previous'), {
      activeKid: 'previous',
      kids: ['2026-07', 'previous'],
    });
    assert.doesNotThrow(() =>
      verifyInternalToken(
        issue({}, { keyring: json }),
        { keyring: json, clock: () => NOW },
      ),
    );
    expectCode(
      () => validateInternalHmacKeyring(KEYRING, 'missing'),
      'INTERNAL_TOKEN_ACTIVE_KID_UNKNOWN',
    );
  });

  it('rejects weak, padded, malformed, duplicate and non-data key material', () => {
    expectCode(
      () =>
        validateInternalHmacKeyring(
          { weak: Buffer.alloc(31).toString('base64url') },
          'weak',
        ),
      'INTERNAL_TOKEN_KEYRING_INVALID',
    );
    for (const encoded of [`${KEY}=`, 'abcde', 'ab+c', 'ab/c']) {
      assert.throws(
        () => validateInternalHmacKeyring({ bad: encoded }, 'bad'),
        InternalHmacError,
      );
    }
    expectCode(
      () =>
        validateInternalHmacKeyring(
          `{"same":"${KEY}","same":"${OTHER_KEY}"}`,
          'same',
        ),
      'INTERNAL_TOKEN_KEYRING_INVALID',
    );
    const accessor = {};
    Object.defineProperty(accessor, 'kid', {
      enumerable: true,
      get: () => KEY,
    });
    expectCode(
      () => validateInternalHmacKeyring(accessor, 'kid'),
      'INTERNAL_TOKEN_KEYRING_INVALID',
    );
  });

  it('rejects an unknown token kid without trying another key', () => {
    const oldToken = issue({}, {
      keyring: { old: KEY },
      activeKid: 'old',
    });
    expectCode(
      () =>
        verifyInternalToken(oldToken, {
          keyring: { current: KEY },
          clock: () => NOW,
        }),
      'INTERNAL_TOKEN_UNKNOWN_KID',
    );
  });

  it('rejects missing and extra issue or final claims', () => {
    const missing = { ...ISSUE_CLAIMS };
    delete missing.run_id;
    expectCode(
      () =>
        issueInternalToken({
          keyring: KEYRING,
          activeKid: '2026-07',
          claims: missing,
          clock: () => NOW,
          randomBytes: () => RANDOM_128,
        }),
      'INTERNAL_TOKEN_SCHEMA_INVALID',
    );
    expectCode(
      () => issue({ unexpected: 'no' }),
      'INTERNAL_TOKEN_SCHEMA_INVALID',
    );

    const finalMissing = fullClaims();
    delete finalMissing.aud;
    expectCode(
      () => validateInternalTokenClaims(finalMissing),
      'INTERNAL_TOKEN_SCHEMA_INVALID',
    );
    expectCode(
      () => validateInternalTokenClaims({ ...fullClaims(), extra: true }),
      'INTERNAL_TOKEN_SCHEMA_INVALID',
    );
  });

  it('rejects numeric coercion, booleans, floats, non-positive and unsafe integers', () => {
    for (const value of [
      '7',
      true,
      7.5,
      0,
      -1,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expectCode(
        () => issue({ execution_fence_token: value }),
        'INTERNAL_TOKEN_CLAIM_INVALID',
      );
    }
    for (const [field, value] of [
      ['token_version', '1'],
      ['token_version', true],
      ['request_hash_version', 1.1],
      ['iat', '1700000000'],
      ['nbf', Number.MAX_SAFE_INTEGER + 1],
      ['exp', false],
    ]) {
      expectCode(
        () => validateInternalTokenClaims(fullClaims({ [field]: value })),
        'INTERNAL_TOKEN_CLAIM_INVALID',
      );
    }
  });

  it('allows null Run/fence only for the exact pre-run session ensure profile', () => {
    const preRun = {
      run_id: null,
      execution_fence_token: null,
      tool_name: 'session.ensure',
      scope: ['sandbox.sessions.ensure'],
      htu: '/internal/v1/sessions/ensure',
    };
    const verified = verifyInternalToken(issue(preRun), {
      keyring: KEYRING,
      clock: () => NOW,
    });
    assert.equal(verified.run_id, null);
    assert.equal(verified.execution_fence_token, null);

    for (const overrides of [
      { ...preRun, tool_name: 'write' },
      { ...preRun, scope: ['sandbox.files.write'] },
      { ...preRun, htu: '/internal/v1/sessions/not-ensure' },
      { ...preRun, run_id: ISSUE_CLAIMS.run_id },
      { ...preRun, execution_fence_token: 1 },
    ]) {
      expectCode(
        () => issue(overrides),
        'INTERNAL_TOKEN_CLAIM_INVALID',
      );
    }
  });

  it('enforces POST and an ASCII absolute query-free fragment-free path', () => {
    expectCode(
      () => issue({ htm: 'GET' }),
      'INTERNAL_TOKEN_CLAIM_INVALID',
    );
    for (const htu of [
      'internal/v1/bash',
      '/internal/v1/bash?x=1',
      '/internal/v1/bash#part',
      '/internal/v1/执行',
      '/internal/v1/bad path',
    ]) {
      expectCode(
        () => issue({ htu }),
        'INTERNAL_TOKEN_CLAIM_INVALID',
      );
    }
  });

  it('requires an exact one-element bounded scope', () => {
    for (const scope of [
      [],
      ['a', 'b'],
      'execute:command',
      [''],
      ['x'.repeat(129)],
    ]) {
      expectCode(
        () => issue({ scope }),
        'INTERNAL_TOKEN_CLAIM_INVALID',
      );
    }
    const scopeWithExtra = ['execute:command'];
    scopeWithExtra.extra = true;
    expectCode(
      () => issue({ scope: scopeWithExtra }),
      'INTERNAL_TOKEN_CLAIM_INVALID',
    );
  });

  it('requires lowercase SHA-256 request/body hashes', () => {
    for (const request_hash of ['A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64)]) {
      expectCode(
        () => issue({ request_hash }),
        'INTERNAL_TOKEN_CLAIM_INVALID',
      );
    }
    for (const body_sha256 of ['C'.repeat(64), 'c'.repeat(65)]) {
      expectCode(
        () => issue({ body_sha256 }),
        'INTERNAL_TOKEN_CLAIM_INVALID',
      );
    }
  });

  it('enforces version 1, nbf=iat and a TTL in 1..120 seconds', () => {
    for (const overrides of [
      { token_version: 2 },
      { request_hash_version: 2 },
      { nbf: NOW + 1 },
      { exp: NOW },
      { exp: NOW + 121 },
    ]) {
      expectCode(
        () => validateInternalTokenClaims(fullClaims(overrides)),
        'INTERNAL_TOKEN_CLAIM_INVALID',
      );
    }
    for (const ttlSeconds of [0, -1, 1.5, '60', 121]) {
      expectCode(
        () => issue({}, { ttlSeconds }),
        'INTERNAL_TOKEN_TTL_INVALID',
      );
    }
  });

  it('rejects not-yet-valid and expired tokens at exact boundaries', () => {
    const token = issue({}, { ttlSeconds: 1 });
    expectCode(
      () =>
        verifyInternalToken(token, {
          keyring: KEYRING,
          clock: () => NOW - 1,
        }),
      'INTERNAL_TOKEN_NOT_YET_VALID',
    );
    expectCode(
      () =>
        verifyInternalToken(token, {
          keyring: KEYRING,
          clock: () => NOW + 1,
        }),
      'INTERNAL_TOKEN_EXPIRED',
    );
  });

  it('rejects weak random injection and non-128-bit jti', () => {
    for (const value of [Buffer.alloc(15), Buffer.alloc(17), 'not-bytes']) {
      expectCode(
        () => issue({}, { randomBytes: () => value }),
        'INTERNAL_TOKEN_RANDOM_INVALID',
      );
    }
    for (const jti of [
      Buffer.alloc(15).toString('base64url'),
      `${Buffer.alloc(16).toString('base64url')}=`,
      'not+base64url',
    ]) {
      assert.throws(
        () => validateInternalTokenClaims(fullClaims({ jti })),
        InternalHmacError,
      );
    }
  });

  it('enforces identifier bounds and printable ASCII', () => {
    for (const tool_call_id of ['', ' call', '调用', 'x'.repeat(256)]) {
      expectCode(
        () => issue({ tool_call_id }),
        'INTERNAL_TOKEN_CLAIM_INVALID',
      );
    }
  });

  it('rejects extra/missing header keys and non-HS256 headers', () => {
    const claims = fullClaims();
    for (const header of [
      { alg: 'none', kid: '2026-07', typ: INTERNAL_TOKEN_TYPE },
      { alg: 'HS256', kid: '2026-07', typ: 'JWT' },
      {
        alg: 'HS256',
        kid: '2026-07',
        typ: INTERNAL_TOKEN_TYPE,
        extra: true,
      },
      { alg: 'HS256', typ: INTERNAL_TOKEN_TYPE },
    ]) {
      assert.throws(
        () =>
          verifyInternalToken(rawSignedToken(header, claims), {
            keyring: KEYRING,
            clock: () => NOW,
          }),
        InternalHmacError,
      );
    }
  });

  it('rejects tampering, padded compact segments and non-canonical JSON', () => {
    const token = issue();
    const [header, claims, signature] = token.split('.');
    expectCode(
      () =>
        verifyInternalToken(`${header}.${claims}.${signature.slice(0, -1)}A`, {
          keyring: KEYRING,
          clock: () => NOW,
        }),
      'INTERNAL_TOKEN_SIGNATURE_INVALID',
    );
    assert.throws(
      () =>
        verifyInternalToken(`${header}=.${claims}.${signature}`, {
          keyring: KEYRING,
          clock: () => NOW,
        }),
      InternalHmacError,
    );

    const reorderedHeader = {
      kid: '2026-07',
      alg: 'HS256',
      typ: INTERNAL_TOKEN_TYPE,
    };
    expectCode(
      () =>
        verifyInternalToken(rawSignedToken(reorderedHeader, fullClaims()), {
          keyring: KEYRING,
          clock: () => NOW,
        }),
      'INTERNAL_TOKEN_HEADER_INVALID',
    );
  });

  it('low-level signing is deterministic for a complete validated claim set', () => {
    const first = signInternalToken({
      keyring: KEYRING,
      activeKid: '2026-07',
      claims: fullClaims(),
    });
    const second = signInternalToken({
      keyring: KEYRING,
      activeKid: '2026-07',
      claims: fullClaims(),
    });
    assert.equal(first, second);
  });
});

describe('cross-language HS256 internal token golden fixture', () => {
  const fixture = JSON.parse(readFileSync(GOLDEN_FIXTURE_PATH, 'utf8'));

  it('loads shared golden fixture metadata', () => {
    assert.equal(fixture.version, 1);
    assert.equal(fixture.contract, 'agent-sandbox-internal-hmac-hs256-v1');
    assert.ok(Array.isArray(fixture.valid) && fixture.valid.length >= 1);
    assert.ok(Array.isArray(fixture.invalid) && fixture.invalid.length >= 1);
  });

  for (const row of fixture.valid) {
    it(`issues and verifies exact golden token: ${row.id}`, () => {
      const keyring = Object.freeze({
        [fixture.key.kid]: fixture.key.keyBase64url,
      });
      const randomBytes = Buffer.from(fixture.randomBytesBase64url, 'base64url');
      assert.equal(randomBytes.length, 16);

      const token = issueInternalToken({
        keyring,
        activeKid: fixture.key.kid,
        claims: row.issueClaims,
        ttlSeconds: fixture.ttlSeconds,
        clock: () => fixture.now,
        randomBytes: (size) => {
          assert.equal(size, 16);
          return new Uint8Array(randomBytes);
        },
      });
      assert.equal(token, row.expectedToken);

      const verified = verifyInternalToken(token, {
        keyring,
        clock: () => fixture.now,
      });
      assert.deepEqual(verified, row.expectedClaims);

      // Request-binding body digest matches the fixture raw body.
      const bodyDigest = createHash('sha256')
        .update(row.request.rawBodyUtf8, 'utf8')
        .digest('hex');
      assert.equal(bodyDigest, row.expectedClaims.body_sha256);
      assert.equal(row.request.method, 'POST');
      assert.equal(row.request.rawPath, row.expectedClaims.htu);
    });
  }

  for (const row of fixture.invalid) {
    if (row.kind === 'signature') {
      it(`rejects golden negative vector: ${row.id}`, () => {
        const keyring = Object.freeze({
          [fixture.key.kid]: fixture.key.keyBase64url,
        });
        expectCode(
          () =>
            verifyInternalToken(row.token, {
              keyring,
              clock: () => fixture.now,
            }),
          row.nodeErrorCode,
        );
      });
    } else if (row.kind === 'body') {
      it(`rejects golden body mismatch: ${row.id}`, () => {
        const positive = fixture.valid.find((v) => v.id === row.tokenRef);
        assert.ok(positive, `missing tokenRef ${row.tokenRef}`);
        const tamperedDigest = createHash('sha256')
          .update(row.rawBodyUtf8, 'utf8')
          .digest('hex');
        assert.notEqual(
          tamperedDigest,
          positive.expectedClaims.body_sha256,
        );
        // Token itself remains valid; only the request body binding fails.
        const keyring = Object.freeze({
          [fixture.key.kid]: fixture.key.keyBase64url,
        });
        assert.doesNotThrow(() =>
          verifyInternalToken(positive.expectedToken, {
            keyring,
            clock: () => fixture.now,
          }),
        );
      });
    }
  }
});
