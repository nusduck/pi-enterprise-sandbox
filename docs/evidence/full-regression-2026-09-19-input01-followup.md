# Full regression follow-up: dual-question input handling (2026-09-19)

## Scope

- Case: `INPUT-01`.
- Method: real browser interaction in a fresh conversation.
- Prompt required `ask_user_question` to collect two choices before answering: audience (`Management`/`Engineering`) and year range (`2021-2023`/`2024-2026`).

## Observation

1. The run entered `Waiting input · 1 tool` and rendered an `Audience` card with buttons `Management` and `Engineering`.
2. Selecting `Management` caused the run to complete as `Succeeded · 1 tool · 21s`.
3. No year-range card or second choice was exposed in the browser interaction. The rendered thought/output explicitly recorded `audience = Management` and `year range = not answered`.
4. The model did not invent a year range and did not emit the requested `INPUT_DUAL_OK` token; it explained that the pair was incomplete.
5. Trace prefix: `23be6a65`; sandbox label: `WD1DA7`.

## Result

`INPUT-01` remains **PARTIAL**. The real WAITING_INPUT state, first answer, and fail-safe non-fabrication behavior are proven. The two-question interaction did not complete: the second question was not surfaced/collected, so final analysis based on both selections was not possible.

