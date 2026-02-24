# SOTU Fact Check Prototype

Prototype pipeline for:

`YouTube URL -> live audio ingest -> transcript -> claim detection -> fact-check lookup (+ FRED enrichment for economic claims) -> producer approval -> output package API -> HTML5 overlay`

## What this prototype does

- Pulls live/broadcast audio from YouTube with `yt-dlp`.
- Converts audio to mono PCM chunks using `ffmpeg`.
- Sends each chunk to Gemini transcription via the Google Generative Language API.
- Extracts likely factual claims from transcript text.
- Looks up related fact checks via Google Fact Check Tools API.
- Enriches economic claims with latest FRED indicators when available.
- Streams updates to browser clients over Server-Sent Events (`/events`).
- Renders a control UI (`/`) and an overlay UI (`/overlay`) for HTML5 graphics.
- Automatically fact-checks every detected claim, then requires explicit approval before graphics output.
- Generates a flat output package for approved claims (for manual Takumi/platform upload).
- Queues a render job for approved claims (remote Takumi webhook or local fallback artifact).
- Optionally logs all events/actions/packages to Neon Postgres for audit and recovery analysis.
- Includes Takumi implementation notes from GridScout/PitchScout clones in `public/takumi-reference.md`.

## Can I just play a YouTube stream for ingest?

Yes. For this prototype you usually **do not need to play it in a browser**. You can provide a YouTube URL directly and ingest audio with `yt-dlp`.

If you are producing on-air content, verify you have rights to use that source and comply with platform terms.

## Requirements

- Node.js 20+
- `yt-dlp` on PATH
- `ffmpeg` on PATH
- `GEMINI_API_KEY` (required)
- `GOOGLE_FACT_CHECK_API_KEY` (recommended)
- `FRED_API_KEY` (recommended for economic claim enrichment)
- `CONTROL_PASSWORD` (recommended for protected control endpoints)
- `DATABASE_URL` (optional Neon Postgres for durable activity logging)
- `TAKUMI_RENDER_URL` (optional remote render webhook; endpoint can return JSON `artifactUrl`/`imageBase64` or raw image bytes)
- `RENDER_TIMEOUT_MS` (optional renderer timeout; default 5000ms)
- `MAX_RESEARCH_CONCURRENCY` (optional; default 3)
- `CLAIM_DETECTION_THRESHOLD` (optional; default `0.62`; higher = fewer but cleaner claims)
- `INGEST_RECONNECT_ENABLED` (optional; default `true`)
- `INGEST_MAX_RETRIES` (optional; default `0` for infinite retries)
- `INGEST_RETRY_BASE_MS` (optional; default 1000)
- `INGEST_RETRY_MAX_MS` (optional; default 15000)
- `INGEST_STALL_TIMEOUT_MS` (optional; default 45000)
- `INGEST_VERBOSE_LOGS` (optional; default `false`; enable for yt-dlp diagnostics)
- `PROTECT_READ_ENDPOINTS` (optional; default `true` in production, else `false`)
- `CONTROL_RATE_LIMIT_PER_MIN` (optional per-IP + route guard; default 120)

On macOS, if needed:

```bash
brew install ffmpeg yt-dlp
```

## Setup

```bash
cp .env.example .env
# edit .env with keys
npm install
npm run start
```

Then open:

- Control UI: `http://127.0.0.1:8787/`
- Overlay UI: `http://127.0.0.1:8787/overlay`

## Live ingest resilience

The ingest supervisor keeps a run alive across transient upstream drops:

- Auto-reconnect is enabled by default (`INGEST_RECONNECT_ENABLED=true`).
- Retry policy defaults to infinite retries (`INGEST_MAX_RETRIES=0`) until manual `/stop`.
- Reconnect uses exponential backoff from `INGEST_RETRY_BASE_MS` up to `INGEST_RETRY_MAX_MS`.
- If no audio bytes are received for `INGEST_STALL_TIMEOUT_MS`, the run marks ingest stalled and reconnects.
- Set `INGEST_VERBOSE_LOGS=true` during rehearsal/incident response to surface richer yt-dlp diagnostics.

`GET /health` includes ingest telemetry (`ingestState`, `reconnectAttempt`, `lastIngestExit`, `lastIngestEventAt`) for operator checks.

## Claim quality tuning

Claim extraction now buffers partial transcript tails and prefers complete sentence boundaries before creating claims, which reduces chunk-boundary fragments that often become `unverified`.

- Tune strictness with `CLAIM_DETECTION_THRESHOLD` (range `0.55` to `0.9`).
- For dense, noisy speech, try `0.68` to reduce low-context detections.

## Docker setup

Build and run directly:

```bash
docker build -t sotu-factcheck-prototype:latest .
docker run --rm -p 8787:8787 --env-file .env -e HOST=0.0.0.0 sotu-factcheck-prototype:latest
```

Or with Compose:

```bash
docker compose up --build -d
docker compose logs -f
```

Then open:

- Control UI: `http://127.0.0.1:8787/`
- Overlay UI: `http://127.0.0.1:8787/overlay`

## API endpoints

- `GET /health` - service readiness and key presence
- `GET /auth-status` - whether control password auth is required
- `POST /start` - start pipeline
- `POST /stop` - stop pipeline
- `GET /claims` - current claim queue
- `POST /claims/:claimId/approve-output` - approve a fact-checked claim for overlay
- `POST /claims/:claimId/reject-output` - reject/remove a claim from overlay
- `POST /claims/:claimId/generate-package` - regenerate output package for an approved claim
- `POST /claims/:claimId/render-image` - queue/retry rendered graphics asset for an approved claim
- `POST /claims/:claimId/tag-override` - operator override for `claimTypeTag` (`numeric_factual`/`simple_policy`/`other`)
- `GET /claims/:claimId/output-package` - fetch output package payload for a claim
- `GET /claims/:claimId/render-job` - fetch latest render job status for a claim
- `GET /output-packages` - list generated output packages (optionally `?runId=...`)
- `GET /events` - SSE stream for graphics and control clients

Example `POST /start` body:

```json
{
  "youtubeUrl": "https://www.youtube.com/watch?v=VIDEO_ID"
}
```

All claim mutation endpoints require JSON `expectedVersion` (optimistic concurrency guard).

## Event types on `/events`

- `pipeline.started`
- `pipeline.reconnect_scheduled`
- `pipeline.reconnect_started`
- `pipeline.reconnect_succeeded`
- `pipeline.ingest_stalled`
- `pipeline.log`
- `audio.chunk`
- `transcript.segment`
- `transcript.error`
- `claim.detected`
- `claim.researching`
- `claim.updated`
- `claim.output_approved`
- `claim.output_rejected`
- `claim.output_package_queued`
- `claim.output_package_ready`
- `claim.output_package_failed`
- `claim.render_queued`
- `claim.render_ready`
- `claim.render_failed`
- `pipeline.error`
- `pipeline.stopped`

## Control password auth

When `CONTROL_PASSWORD` is set, clients must send:

`x-control-password: <your password>`

on mutating endpoints (`/start`, `/stop`, claim approval/reject/package/render/tag override).

If `PROTECT_READ_ENDPOINTS=true`, the same secret is required for:

- `GET /claims`
- `GET /events`
- `GET /output-packages`
- `GET /claims/:claimId/output-package`
- `GET /claims/:claimId/render-job`

For browser `EventSource`, use query auth:

`/events?control_password=<your password>`

Optional operator attribution headers:

- `x-operator-id: <producer name or device id>`
- JSON body field `reason` for approve/reject/package actions

## Neon activity logging

When `DATABASE_URL` is configured, the server writes to:

Use a connection string with `sslmode=verify-full` (for example, `...?sslmode=verify-full&channel_binding=require`) to keep strong TLS semantics and avoid pg SSL compatibility warnings.

- `activity_events` (all emitted pipeline/claim events)
- `claim_actions` (approve/reject/package attempts and outcomes)
- `output_packages` (latest package status/payload metadata)
- `render_jobs` (render queue status, artifact URLs, and failures)

DB status is visible on `GET /health` under `database`.
On startup, the server attempts to hydrate the in-memory claims view from the latest run in Neon.

## AWS hosting notes

- Default host is `127.0.0.1`; for direct host binding on AWS set `HOST=0.0.0.0`.
- Prefer placing the app behind an HTTPS reverse proxy or ALB.
- Keep `CONTROL_PASSWORD` and API keys in AWS Secrets Manager/SSM, not in repo files.
- Restrict inbound access with security groups to trusted operator IPs.
- If you expose read endpoints publicly, add gateway auth for `/claims`, `/events`, and package endpoints.
- For container deployments (ECS/EC2), use the provided `Dockerfile` and pass env vars at runtime (task definition/SSM/Secrets Manager), not baked into the image.

## Important caveats

- This is a prototype. Claim detection and verdict mapping are heuristic.
- Automated verdicts should stay producer-gated before on-air use.
- Some live streams may throttle, break, or geo-restrict `yt-dlp` ingest.
- Fact-check coverage depends on available published checks.
