# Implementation plan

- [ ] Introduce or reuse lightweight test runner + DOM environment.
- [ ] Extract/test incremental SSE parsing (split chunks, flush, malformed, abort).
- [ ] Explicit stream/conversation/approval/artifact transitions; prevent stale state.
- [ ] Replace unsafe untrusted `innerHTML`/inline handlers with safe DOM APIs.
- [ ] Accessible live status/error/approval semantics and keyboard basics.
- [ ] Verify upload retry and artifact-only download behavior.
- [ ] Run frontend tests + production build.

## Validation commands

```bash
# adapt to project scripts
npm test --prefix frontend || npm test
npm run build --prefix frontend || npm run build
```
