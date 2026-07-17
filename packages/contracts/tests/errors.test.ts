import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ERROR_CODE_CATEGORIES,
  errorCodeCategory,
  isValidErrorCode,
  isKnownErrorCode,
  makeErrorResponse,
  parseErrorResponse,
} from '../src/errors/index.ts';

const TRACE = 'b7e1f3a2c4d5060708090a0b0c0d0e0f';
const REQUEST = '01K0G2PAV8FPMVC9QHJG7JPN4Z';

describe('error code taxonomy (§26)', () => {
  it('lists required categories', () => {
    for (const cat of [
      'AUTH',
      'TENANT',
      'CONVERSATION',
      'SESSION',
      'RUN',
      'TOOL',
      'SANDBOX',
      'PROCESS',
      'DATASET',
      'ARTIFACT',
      'MCP',
      'APPROVAL',
      'A2A',
      'INTERNAL',
    ]) {
      assert.ok((ERROR_CODE_CATEGORIES as readonly string[]).includes(cat), cat);
    }
  });

  it('validates known and well-formed extension codes', () => {
    assert.equal(isKnownErrorCode('RUN_NOT_FOUND'), true);
    assert.equal(isValidErrorCode('RUN_NOT_FOUND'), true);
    assert.equal(isValidErrorCode('RUN_CUSTOM_REASON'), true);
    assert.equal(errorCodeCategory('RUN_NOT_FOUND'), 'RUN');
    assert.equal(isValidErrorCode('not_a_code'), false);
    assert.equal(isValidErrorCode('UNKNOWN_PREFIX_X'), false);
    assert.equal(isValidErrorCode('RUN'), false); // needs CATEGORY_REASON
  });
});

describe('error response envelope (§26)', () => {
  it('parses the unified error response', () => {
    const raw = {
      error: {
        code: 'RUN_NOT_FOUND',
        message: 'The requested run was not found.',
        requestId: REQUEST,
        traceId: TRACE,
      },
    };
    const parsed = parseErrorResponse(raw);
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.value.error.code, 'RUN_NOT_FOUND');
      assert.equal(parsed.value.error.traceId, TRACE);
    }
  });

  it('rejects stack traces and invalid codes', () => {
    assert.equal(
      parseErrorResponse({
        error: {
          code: 'RUN_NOT_FOUND',
          message: 'x',
          requestId: REQUEST,
          traceId: TRACE,
          stack: 'Error: boom',
        },
      }).ok,
      false,
    );
    assert.equal(
      parseErrorResponse({
        error: {
          code: 'oops',
          message: 'x',
          requestId: REQUEST,
          traceId: TRACE,
        },
      }).ok,
      false,
    );
  });

  it('makeErrorResponse builds a valid payload', () => {
    const res = makeErrorResponse({
      code: 'AUTH_REQUIRED',
      message: 'Authentication required.',
      requestId: REQUEST,
      traceId: TRACE.toUpperCase(),
    });
    assert.equal(res.error.traceId, TRACE);
    assert.equal(res.error.code, 'AUTH_REQUIRED');
  });
});
