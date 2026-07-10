# Python agent production cutover

## Goal

Complete Python-first agent orchestration parity and route production chat through a reversible, config-selected Python path while Node remains a thin edge/BFF.

## Requirements

### R1 — Runtime ownership

- Resolve dual runtime: Node hosts edge/BFF only; Python owns agent orchestration, tool binding, approval, trace, and message restore—or document a bounded compatibility transition with explicit flags.
- Do not silently remove the known-working Node path until parity tests pass.

### R2 — Feature parity

The selected production chat route must support the same user-visible behavior as the current route:

- SSE event contract (token, tool, approval, file/artifact, error, done)
- Multi-turn history restore
- Tools and approval flows
- Artifact delivery (explicit submit only)
- Abort/cancel where supported

### R3 — Cutover control

- Route selection is explicit via configuration (feature flag / env).
- Rollback: flip config back to Node-compat without redeploying frontend.
- No silent default flip until multi-turn, tool, approval, artifact, error, and abort scenarios pass.

### R4 — Contract stability

- Shared SSE fixtures prevent drift between Python producer, Node proxy, and browser consumer.
- Documented public REST/SSE behavior remains compatible unless a deliberate migration updates frontend and tests in the same change.

## Acceptance Criteria

- [ ] Inventory of Node `handleChat` vs `sandbox/agent` parity is written and gaps closed or explicitly deferred with user approval.
- [ ] Config-selected production route exists (Python agent or Node proxy-to-Python) with reversible compatibility mode.
- [ ] Parity tests cover multi-turn, tools, approval, artifact, error, and abort through the selected route.
- [ ] Frontend continues to work against the BFF without requiring dual client logic beyond existing env.
- [ ] Rollback procedure is documented in active docs / `.env.example`.
- [ ] Relevant Python/Node/integration suites pass.

## Out of Scope

- Multi-user ownership.
- Frontend DOM/SSE parser hardening beyond what is needed for contract fixtures (child `07-11-frontend-resilience-security`).
- Full CI matrix (child `07-11-quality-operations-docs`).

## Dependencies

- Prefer after lifecycle/cancel and security foundations so agent cancel and auth fixtures are reliable.
