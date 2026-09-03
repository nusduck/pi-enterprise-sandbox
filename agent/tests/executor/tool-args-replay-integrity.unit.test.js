/**
 * Long tool arguments must survive an approval round-trip.
 *
 * The ToolExecution ledger stores an integrity envelope: `$payload` is the
 * *redacted* view and `$integrity` commits to the *original* arguments.
 * `resumeApprovedToolCall` used to replay from `$payload`, so a `command` /
 * `content` argument longer than DEFAULT_MAX_STRING (512) came back truncated:
 * the replay fingerprint no longer matched and the Run died with
 * "tool_call_id replay conflicts with existing args integrity" — and had it
 * matched, the approved tool would have executed on truncated input.
 *
 * The Pi session holds what the model actually emitted, so that is the
 * authority; the ledger view is used only when it provably equals the original.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  packJsonWithIntegrity,
  publicJsonView,
  extractIntegrity,
  integrityFingerprint,
  assertToolExecutionReplayMatch,
  MAX_ARGS_JSON_BYTES,
} from '../../src/infrastructure/mysql/repositories/tool-execution-repository.js';
import { findToolCallArgumentsInSession } from '../../src/application/dsh-run-input.js';

const TOOL = { toolName: 'bash', toolSource: 'sandbox' };
const TOOL_CALL_ID = 'call_abc123';
const LONG_COMMAND = `echo ${'a'.repeat(900)}`;

/** Mirror of the repository's row → public mapping, args only. */
function ledgerRow(originalArgs) {
  const parsed = JSON.parse(
    packJsonWithIntegrity(originalArgs, MAX_ARGS_JSON_BYTES),
  );
  return {
    ...TOOL,
    toolCallId: TOOL_CALL_ID,
    toolExecutionId: '01K0G2PAV8FPMVC9QHJG7JPN70',
    argumentsJson: publicJsonView(parsed) ?? {},
    _argsIntegrity: extractIntegrity(parsed),
  };
}

function sessionWithToolCall(args) {
  return {
    agent: {
      state: {
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'run it' }] },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'calling bash' },
              {
                type: 'toolCall',
                id: TOOL_CALL_ID,
                name: 'bash',
                arguments: args,
              },
            ],
          },
          { role: 'toolResult', toolCallId: TOOL_CALL_ID, content: [] },
        ],
      },
    },
  };
}

describe('ledger view of long arguments', () => {
  it('is lossy above 512 chars, which is why it cannot drive a replay', () => {
    const original = { command: LONG_COMMAND, timeoutMs: 30000 };
    const row = ledgerRow(original);
    assert.notDeepEqual(row.argumentsJson, original);
    assert.throws(
      () =>
        assertToolExecutionReplayMatch(row, {
          ...TOOL,
          argumentsJson: row.argumentsJson,
        }),
      /args integrity/,
      'replaying the redacted view is exactly the production failure',
    );
  });

  it('still commits to the original arguments', () => {
    const original = { command: LONG_COMMAND };
    assert.equal(ledgerRow(original)._argsIntegrity, integrityFingerprint(original));
  });

  it('keeps short arguments lossless, so the ledger view stays usable', () => {
    const original = { command: 'ls -la', timeoutMs: 5000 };
    const row = ledgerRow(original);
    assert.deepEqual(row.argumentsJson, original);
    assert.equal(integrityFingerprint(row.argumentsJson), row._argsIntegrity);
  });

  it('reports arguments too large to store as ARGUMENT_TOO_LARGE', () => {
    // Redaction shortens long *strings*, so the cap is only reached by breadth.
    const wide = {};
    for (let i = 0; i < 5000; i += 1) wide[`field_${i}`] = `value_${i}`;
    assert.throws(() => packJsonWithIntegrity(wide, MAX_ARGS_JSON_BYTES), {
      code: 'ARGUMENT_TOO_LARGE',
    });
  });

  it('still keeps credentials out of the stored arguments', () => {
    const stored = packJsonWithIntegrity(
      {
        command: 'curl -H "Authorization: Bearer sk-abcdef0123456789"',
        api_key: 'sk-abcdef0123456789',
      },
      MAX_ARGS_JSON_BYTES,
    );
    assert.ok(!stored.includes('sk-abcdef0123456789'));
  });
});

describe('recovering approved-replay arguments from the Pi session', () => {
  it('returns the original long arguments the model emitted', () => {
    const original = { command: LONG_COMMAND, timeoutMs: 30000 };
    const found = findToolCallArgumentsInSession(
      sessionWithToolCall(original),
      TOOL_CALL_ID,
    );
    assert.equal(found.found, true);
    assert.deepEqual(found.args, original);
  });

  it('produces args that replay without an integrity conflict', () => {
    const original = { command: LONG_COMMAND, timeoutMs: 30000 };
    const row = ledgerRow(original);
    const found = findToolCallArgumentsInSession(
      sessionWithToolCall(original),
      TOOL_CALL_ID,
    );
    assert.doesNotThrow(() =>
      assertToolExecutionReplayMatch(row, {
        ...TOOL,
        argumentsJson: found.args,
      }),
    );
  });

  it('falls back to the durable branch when live state is gone', () => {
    const original = { command: LONG_COMMAND };
    const found = findToolCallArgumentsInSession(
      {
        agent: { state: { messages: [] } },
        sessionManager: {
          getEntries: () => [
            {
              type: 'message',
              message: {
                role: 'assistant',
                content: [
                  {
                    type: 'toolCall',
                    id: TOOL_CALL_ID,
                    name: 'bash',
                    arguments: original,
                  },
                ],
              },
            },
          ],
        },
      },
      TOOL_CALL_ID,
    );
    assert.equal(found.found, true);
    assert.deepEqual(found.args, original);
  });

  it('reports not-found rather than guessing', () => {
    assert.deepEqual(
      findToolCallArgumentsInSession(sessionWithToolCall({ command: 'x' }), 'other_id'),
      { found: false },
    );
    assert.deepEqual(findToolCallArgumentsInSession(null, TOOL_CALL_ID), {
      found: false,
    });
  });

  it('ignores a tool call with the same id on a non-assistant message', () => {
    const session = {
      agent: {
        state: {
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'toolCall',
                  id: TOOL_CALL_ID,
                  name: 'bash',
                  arguments: { command: 'injected' },
                },
              ],
            },
          ],
        },
      },
    };
    assert.deepEqual(findToolCallArgumentsInSession(session, TOOL_CALL_ID), {
      found: false,
    });
  });
});
