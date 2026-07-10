# Implementation plan

- [x] Establish clean-install commands for Python, API Server, Frontend; record baseline.
- [x] Configure CI jobs for Python, Node/frontend tests, frontend build, Compose validation.
- [x] Add only lint/type/format gates that are configured and reproducible.
- [x] Improve readiness vs health without leaking details.
- [x] Run clean-install full suites and Compose config validation.
- [x] Update active docs, `.env.example`, Trellis specs, improvement status.
- [x] Support parent requirement-by-requirement completion audit with evidence links.

## Validation commands

```bash
uv run pytest tests/ -q --tb=short
node --test api-server/tests/*.test.js
npm test --prefix frontend
npm run build --prefix frontend
docker compose config -q
```

Evidence: `research/verification-evidence.md`
