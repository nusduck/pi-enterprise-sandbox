# Design — Frontend Parent

## Tech (ADR §12)

Vite, React, TypeScript, React Router, TanStack Query, Zustand, Zod; feature-based structure under `frontend/src/`.

## Layout

Navigation | Conversation/Run Timeline | Context Inspector.

## SSE

POST /runs → run_id; GET /runs/{id}/events SSE; Last-Event-ID, dedupe, multi-run.
