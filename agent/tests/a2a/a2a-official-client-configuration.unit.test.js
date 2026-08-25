/**
 * `message/stream` must open an SSE stream for the configuration the official
 * a2a-python / a2a-js clients actually send.
 *
 * `ClientConfig.accepted_output_modes` defaults to an empty list, and the A2A
 * samples/spec commonly use the short form `["text"]`. Both used to be rejected
 * as CONTENT_TYPE_NOT_SUPPORTED, and a JSON-RPC error for a streaming method
 * comes back as `application/json` — which the official client surfaces as
 * "Invalid SSE response or protocol error: Expected response header
 * Content-Type to contain 'text/event-stream', got 'application/json'".
 *
 * The repo's own StandardA2aClient never sent `configuration`, so nothing
 * covered this.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSendConfiguration,
  parseSendParams,
} from '../../src/application/a2a/task-request.js';
import { A2A_SUPPORTED_OUTPUT_MODES } from '../../src/application/a2a/agent-card.js';

/** What a2a-python's ClientFactory puts in params for message/stream. */
function officialStreamParams(acceptedOutputModes) {
  return {
    message: {
      role: 'user',
      parts: [{ kind: 'text', text: 'Summarize the dataset' }],
      messageId: '4f1c2e2a-0d6e-4a1a-9e2f-1d1a1f2b3c4d',
      kind: 'message',
    },
    configuration: {
      acceptedOutputModes,
      blocking: false,
    },
    metadata: null,
  };
}

describe('official A2A client configuration is accepted', () => {
  it('accepts the default empty acceptedOutputModes (no preference)', () => {
    const params = parseSendParams(officialStreamParams([]));
    assert.doesNotThrow(() => assertSendConfiguration(params.configuration));
  });

  it('accepts the short form "text"', () => {
    const params = parseSendParams(officialStreamParams(['text']));
    assert.doesNotThrow(() => assertSendConfiguration(params.configuration));
  });

  it('accepts wildcards', () => {
    for (const modes of [['*/*'], ['text/*'], ['text/*', 'application/json']]) {
      assert.doesNotThrow(
        () => assertSendConfiguration({ acceptedOutputModes: modes }),
        `expected ${JSON.stringify(modes)} to be accepted`,
      );
    }
  });

  it('accepts an explicit supported mode', () => {
    for (const mode of A2A_SUPPORTED_OUTPUT_MODES) {
      assert.doesNotThrow(() =>
        assertSendConfiguration({ acceptedOutputModes: [mode] }),
      );
    }
  });

  it('accepts snake_case accepted_output_modes', () => {
    assert.doesNotThrow(() =>
      assertSendConfiguration({ accepted_output_modes: ['text'] }),
    );
  });

  it('still rejects a genuinely unsupported set', () => {
    assert.throws(
      () =>
        assertSendConfiguration({
          acceptedOutputModes: ['image/png', 'video/mp4'],
        }),
      { code: 'CONTENT_TYPE_NOT_SUPPORTED' },
    );
  });

  it('still rejects push notification config', () => {
    assert.throws(
      () =>
        assertSendConfiguration({
          acceptedOutputModes: ['text'],
          pushNotificationConfig: { url: 'https://example.com/hook' },
        }),
      { code: 'PUSH_NOT_SUPPORTED' },
    );
  });
});
