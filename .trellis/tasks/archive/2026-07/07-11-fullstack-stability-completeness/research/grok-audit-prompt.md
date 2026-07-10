You are the implementation worker reporting to a supervising agent. Perform a read-only audit of the current repository for the objective: improve both backend and frontend stability and completeness until the project is production-coherent.

Constraints:

- Do not edit any file, install dependencies, start long-running services, commit, or create branches.
- Never open, read, summarize, or transmit `.env`, credentials, tokens, private keys, local databases, or secret-bearing runtime files. Use `.env.example` only.
- Treat current code/config/tests as authoritative. Existing AUDIT.md, PLAN.md, and IMPROVEMENT_PLAN.md may be stale; verify every claim.
- Read AGENTS.md and relevant .trellis/spec files first.
- Inspect backend (sandbox and api-server), frontend, Docker/Compose, tests, CI, and active docs.
- Focus on concrete defects, incomplete cross-layer flows, security/reliability risks, concurrency/lifecycle bugs, stale contracts, missing tests, and production-operability gaps.
- Do not propose broad rewrites without evidence. Preserve the existing three-service architecture unless a verified requirement demands migration.
- Multi-user ownership, owner-column migrations, cross-user authorization and login-account UX are out of scope for this iteration.

Return a concise report with:

1. Current architecture and verified baseline.
2. Ranked findings using P0/P1/P2; for each include exact file paths, code evidence, user impact, and a specific fix.
3. A phased implementation plan split into independently verifiable backend, frontend, and integration deliverables.
4. Exact acceptance tests/commands for each phase.
5. Items that are uncertain and require product-owner confirmation.

Pay special attention to:

- Python Agent production path versus Node agent path and whether both are coherent.
- Session/conversation/workspace ownership, concurrency, cleanup, and persistence.
- Authentication middleware, exact public-route policy and trusted service-token compatibility in the current single-user deployment.
- Approval lifecycle, cancellation, timeout, and SSE/UI behavior.
- Artifact-only delivery and path authorization.
- Global mutable state in Node and Python under concurrent requests.
- Frontend SSE parser robustness, error recovery, state mutation, XSS, accessibility, and automated test absence.
- API contract mismatches, stale docs/config, Docker health/readiness, CI coverage, and missing dependency/tooling gates.
