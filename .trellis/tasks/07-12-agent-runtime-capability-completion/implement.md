# Implement — Parent Integration Plan

## Checklist

- [ ] Create and review all child PRDs (done in planning batch)
- [ ] Parallel P0: start B1 + B2 + (frontend F1 independently)
- [ ] B3 after process/bash streaming hooks exist
- [ ] B4 after tool paths from B1/B2 stable
- [ ] P1 children after P0 parent gate criteria green
- [ ] Parent integration review + archive only after children done

## Validation (parent)

```bash
# Aggregate after children
node --test agent/tests/*.test.js
uv run pytest tests/ -q --tb=short
# Plus child-specific integration scenarios from ADR §13
```
