# Design — B3

## Event types

execution_started, stdout_delta, stderr_delta, execution_completed, execution_failed, execution_cancelled.

## Transport

Persist → SSE with sequence; GET logs?offset=&limit= for pull.

## Consumers

Agent (tool progress), Frontend workbench (F4).
