# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run start        # Start server (node src/server.mjs)
npm run dev          # Start with file watching (node --watch src/server.mjs)
npm run check        # Syntax-check all source modules (no tests exist)
```

Docker:
```bash
docker compose up --build -d
docker compose logs -f
```

System dependencies: `yt-dlp` and `ffmpeg` must be on PATH.

## Architecture

Zero-dependency Node.js (ESM, `.mjs` files) prototype — the only npm dependency is `pg` for optional Postgres logging. No framework, no bundler, no TypeScript. The server uses raw `node:http` with manual routing.

### Pipeline flow

`YouTube URL` → `yt-dlp` (audio stream) → `ffmpeg` (16kHz mono PCM) → chunked by `CHUNK_SECONDS` → Gemini API transcription → claim detection → parallel fact-check research → SSE broadcast to browser clients

### Source modules (`src/`)

- **server.mjs** — HTTP server, SSE broadcaster, all route handlers, in-memory claim state (`Map`), auth middleware. This is the monolith entry point — routing, state management, and claim lifecycle all live here.
- **pipeline.mjs** — Spawns `yt-dlp` → `ffmpeg` child processes, buffers PCM chunks, queues transcription via Gemini REST API, dispatches detected claims for research. One active pipeline at a time.
- **claimDetector.mjs** — Heuristic sentence-level claim scorer using keyword matching and pattern rules. Classifies claims into `numeric_factual`, `simple_policy`, or `other` tags with a configurable score threshold (default 0.55).
- **factCheckClient.mjs** — Google Fact Check Tools API client. Token-level Jaccard similarity to rank matches. Normalizes textual ratings into `false`/`misleading`/`supported`/`unverified` verdicts.
- **fredClient.mjs** — FRED (Federal Reserve Economic Data) API client. Maps economic claims to known series (unemployment, CPI, GDP, etc.) via keyword catalog and fetches latest observation.
- **policyEngine.mjs** — Fail-closed policy evaluator. Determines approval/export eligibility per claim based on tag-specific confidence thresholds, evidence status, source count, and conflict detection.
- **outputPackageService.mjs** — Generates flat Takumi-format output packages for approved claims.
- **renderService.mjs** — Queues render jobs to a remote Takumi webhook (or local SVG fallback), with retry logic.
- **activityStore.mjs** — Optional Neon Postgres activity logger. Batched async queue (50-item batches) writing to `activity_events`, `claim_actions`, `output_packages`, `render_jobs` tables.
- **env.mjs** — Minimal `.env` file parser (no dotenv dependency). Only sets vars not already in `process.env`.
- **wav.mjs** — Pure-JS PCM-to-WAV header builder for Gemini audio upload.

### Frontend (`public/`)

- **control.html** — Producer control UI (start/stop pipeline, claim review, approve/reject).
- **overlay.html** — HTML5 graphics overlay for OBS/broadcast capture.

### Key patterns

- All real-time communication uses **Server-Sent Events** (`/events`). No WebSocket.
- Claim state is an in-memory `Map` in `server.mjs`, updated via `updateClaimState()`. Each mutation bumps a `version` counter for optimistic concurrency (clients can send `expectedVersion`).
- Every claim state update runs through `evaluateClaimPolicy()` from `policyEngine.mjs` via the `withPolicy()` wrapper.
- The pipeline emits events through `emitEvent()` which broadcasts to SSE clients, updates claim state, and enqueues to the activity store simultaneously.
- Control endpoints require `x-control-password` header when `CONTROL_PASSWORD` env var is set. Uses `timingSafeEqual` comparison.

### Claim lifecycle

`pending_research` → `researching` → `researched` / `needs_manual_research` / `no_match`

Approval: `pending` → `approved` / `rejected` (policy-gated)

Export (package + render): only available after approval passes policy checks.

### Environment variables

Required: `GEMINI_API_KEY`

Recommended: `GOOGLE_FACT_CHECK_API_KEY`, `FRED_API_KEY`, `CONTROL_PASSWORD`

Optional: `DATABASE_URL` (Neon Postgres), `TAKUMI_RENDER_URL`, `RENDER_TIMEOUT_MS`, `CHUNK_SECONDS`, `GEMINI_TRANSCRIBE_MODEL`, `PORT`, `HOST`
