# Design — F2

## Normalized stores

conversationsById, agentSessionsById, runsById, messagesById, toolExecutionsById, processesById, approvalsById, artifactsById, attachmentsById.

## SSE Manager

per runId: lastEventId, connectionStatus, retryCount, abortController.
