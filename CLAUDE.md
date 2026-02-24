# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Live fact-checking pipeline for political speeches: YouTube audio stream → transcription → claim detection → fact-check research → producer approval → graphics output. Built as a zero-framework Node.js prototype with vanilla HTML frontends.

## Commands

```bash
npm run dev          # Start server with --watch auto-reload
npm start            # Production server
npm run check        # Syntax-check all .mjs files (node --check)
```

Docker:
```bash
docker compose up --build -d    # Build and run
docker compose logs -f          # Tail logs
```

No test framework is configured. Validation is manual via API endpoints and the control UI at `http://127.0.0.1:8787/`.

## Architecture

**Runtime:** Node.js 20+ ES modules (.mjs), native HTTP server (no Express), single `pg` dependency.

**System deps:** `yt-dlp` (audio extraction), `ffmpeg` (PCM conversion). On macOS: `brew install ffmpeg yt-dlp`.

**Data flow (unidirectional):**
```
YouTube → yt-dlp → ffmpeg → PCM chunks → Gemini transcription → claim detection (heuristic scoring) → parallel research (Google Fact Check API + FRED API) → Gemini verification → producer approval → output package → render (Takumi webhook or local SVG fallback)
```

**Real-time:** Server-Sent Events (`/events`) push all state changes to browser clients. No WebSocket.

**State:** Claims are held in-memory Maps with optimistic concurrency (version numbers). Optional Neon Postgres (`DATABASE_URL`) provides durable logging and startup hydration.

### Key Source Files (all in `src/`)

| File | Role |
|------|------|
| `server.mjs` | HTTP routing, SSE broadcasting, claim state management, rate limiting, static file serving |
| `pipeline.mjs` | Audio ingest orchestration (yt-dlp/ffmpeg spawning), transcription queuing, claim detection triggering, research queue with concurrency limit, reconnect/stall resilience |
| `claimDetector.mjs` | Heuristic scoring: numbers (+0.45), comparatives (+0.20), keywords (+0.35), length (+0.10). Threshold default 0.62 |
| `factCheckClient.mjs` | Google Fact Check Tools API lookup with Jaccard similarity matching and verdict normalization |
| `fredClient.mjs` | FRED API integration for 8 economic indicators (unemployment, CPI, GDP, etc.) |
| `geminiVerifier.mjs` | Gemini-based verdict generation with structured JSON schema output. Caps confidence at 0.6 without external evidence |
| `policyEngine.mjs` | Approval/export eligibility rules: per-type confidence thresholds, evidence sufficiency, conflict detection |
| `renderService.mjs` | Render job lifecycle (queued→rendering→ready/failed). Remote Takumi webhook or local SVG fallback |
| `outputPackageService.mjs` | Assembles Takumi-compatible output payloads (schema v1.0, template `fc-lower-third-v1`) |
| `activityStore.mjs` | Async batched Postgres logging with auto-schema creation and graceful degradation |

### Frontend (all in `public/`)

| File | Role |
|------|------|
| `control.html` | Producer dashboard: pipeline control, claim queue, approve/reject, tag overrides, package/render status |
| `overlay.html` | On-air graphics overlay: listens to SSE, displays rendered claim artifacts |

Both are vanilla HTML with inline CSS/JS. No build step.

## Key Patterns

- **Event-driven:** Pipeline emits typed events (e.g., `claim.detected`, `pipeline.reconnect_scheduled`); server broadcasts via SSE and logs to Postgres.
- **Optimistic concurrency:** All claim mutation endpoints require `expectedVersion` in the JSON body.
- **Graceful degradation:** Every external service (Postgres, Google FC, FRED, Takumi) is optional. The pipeline works with just `GEMINI_API_KEY`.
- **Ingest resilience:** Auto-reconnect with exponential backoff + jitter. Stall watchdog at 45s. Configurable via `INGEST_*` env vars.
- **Policy-as-code:** `policyEngine.mjs` gates approval/export with per-claim-type thresholds and evidence rules.

## Environment

Only `GEMINI_API_KEY` is required. See `.env.example` for all options. Copy it to `.env` before running.

Auth: Set `CONTROL_PASSWORD` to protect mutating endpoints. Set `PROTECT_READ_ENDPOINTS=true` for read endpoints too. Header: `x-control-password: <password>`.
