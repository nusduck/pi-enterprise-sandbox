# PRD — Add run_python and run_node agent tools

## Problem

Sandbox exposes `POST /executions/python` and `/executions/node`, but the Agent
only wired `bash` → `/executions/command`. Models were forced into
`python3 -c` / `node -e` through the shell policy parser.

## Goals

- [x] Agent client: `executePython` / `executeNode`
- [x] Tools: `run_python` / `run_node` (code + timeout)
- [x] Profile allowlist + `BASE_TOOL_NAMES`
- [x] Policy: both write-class medium; sandbox risk map includes `run_node`
- [x] Unit tests for registration and client forwarding

## Non-goals

- Scanning code bodies for subprocess/network (rely on isolation)
- api-server client parity (not on agent path)
- Changing bash semantics beyond prompt preference text
