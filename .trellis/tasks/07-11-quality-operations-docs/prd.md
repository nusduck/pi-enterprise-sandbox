# Integrated quality gates operations and docs

## Goal

Add clean-install automated quality gates, stack readiness improvements, and documentation that matches implemented behavior after the other hardening children land.

## Requirements

### R1 — CI matrix

- CI installs required runtimes/dependencies and runs:
  - Python tests
  - Node tests (once present)
  - Frontend tests and production build
  - Syntax/lint/type gates actually configured by the project
  - `docker compose config -q` (or project Compose validation)

### R2 — Readiness and ops

- Health vs readiness: process-alive vs dependency-ready distinguished where applicable.
- Production logs/traces useful without leaking secrets.
- Compose smoke path documented for multi-turn, approval, binary upload, cancel, artifact delivery (as stack allows).

### R3 — Documentation accuracy

- Update `README.md`, active `docs/`, `.env.example`, Compose notes, and `.trellis/spec/` when behavior changes.
- Remove or mark stale claims in active audit/plan docs; archived design history stays history.

## Acceptance Criteria

- [ ] CI workflow runs full gates from a clean dependency install definition.
- [ ] Local clean-install commands documented and succeed for Python, API server, frontend.
- [ ] Readiness checks improved without secret leakage.
- [ ] Active docs and Trellis specs match implemented security, lifecycle, agent route, and frontend behavior.
- [ ] Parent requirement-by-requirement audit evidence is attachable from this child's outputs.

## Out of Scope

- Implementing the security/lifecycle/agent/frontend features themselves (other children).
- Multi-user ownership product work.

## Dependencies

- Runs last for integration evidence; may add CI skeleton earlier in parallel.
