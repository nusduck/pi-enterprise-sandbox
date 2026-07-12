# Design — F1

## Migration approach

Scaffold React+TS app alongside or replace `frontend/src` incrementally; port `api.js` → `shared/api/*`, keep behavior parity first.

## Structure seed

app/, entities/, features/, widgets/, pages/, shared/ per ADR §12.2 (minimal for F1).
