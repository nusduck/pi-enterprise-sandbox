# Design: frontend resilience and security

## SSE parser

Extract an incremental consumer:

- Feed(string/Uint8Array chunk) → zero or more events
- Flush() on stream end for trailing buffer
- Abort() clears partial state and stops dispatch

UTF-8 split across chunks must reassemble correctly when using text decoder streaming if binary chunks are used.

## State machine (logical)

States: idle → streaming → awaiting_approval → error/done; plus conversation-scoped store keyed by conversation id.

On switch: abort active stream (or ignore late events by generation token), clear ephemeral UI for previous id.

## Safe rendering

- Untrusted strings → `textContent` or createTextNode
- Links → allowlist same-origin API paths for artifacts/downloads
- No `onclick="..."` built from server data

## Test runner

Use a lightweight runner consistent with Vanilla stack (Node built-in test / vitest / jsdom—pick what already exists or minimal addition). Prefer not introducing a heavy SPA framework.
