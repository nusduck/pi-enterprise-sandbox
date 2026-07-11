# Parent Execution Plan

1. Review and approve child artifacts; do not start the parent as an implementation target.
2. Implement/verify `user-ownership-auth` and `pi-sdk-adoption-adr`.
3. Deliver F-01 attachment repair with forward-compatible IDs/manifest.
4. Deliver A-01 path/workspace isolation and S-02 network allowlist.
5. Deliver S-03 Extension + Sandbox dual policy.
6. Deliver A-03 PostgreSQL Session/event persistence and crash recovery.
7. Remove unused Python Runtime, build independent Node Agent, perform stop-write cutover.
8. Deliver T-01 and development Skill management on the new boundaries.
9. Run full cross-layer integration, migration/rollback rehearsal, security bypass tests and docs audit.
10. Only after all child acceptance criteria pass, archive children and complete parent integration review.

## Parent Validation

```bash
uv run pytest tests/ -q --tb=short
node --test api-server/tests/*.test.js
npm test --prefix frontend
npm run build --prefix frontend
docker compose config -q
python3 ./.trellis/scripts/task.py validate 07-11-field-issues-evolution-planning
```

## Global Rollback Rule

Use expand/contract schemas, immutable backups and application-image rollback. Never run old and new Agent Runtime on the same Run, and never auto-replay an unknown tool call.

