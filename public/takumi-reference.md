# Takumi Render Reference (GridScout + PitchScout)

Snapshot references used:

- `public/third_party/gridscout` @ `3aa9e4e`
- `public/third_party/pitchscout` @ `33b7aa9`

## Observed Patterns

1. `gridscout/apps/images` runs a dedicated Bun image service with:
   - template registry + auto-discovery from `src/templates`
   - `GET /healthz`, `GET /templates`, `POST/GET /generate`
   - deterministic template outputs and explicit template metadata headers

2. GridScout favors payload-first rendering:
   - caller posts all needed data
   - templates stay pure (layout/formatting only)
   - image fetching is optional utility behavior, not required for core flow

3. PitchScout wraps Takumi calls in one renderer function:
   - centralized defaults (DPR, fonts, dimensions)
   - `try/catch` fallback path when image render fails
   - one render per brand group, fan out rendered asset to many targets

## Applied in This Prototype

1. Claim lifecycle remains fail-closed:
   - `detected -> researching -> updated` before approval eligibility
   - approval and export checks remain policy-gated in server state

2. Renderer now supports both common Takumi endpoint styles:
   - JSON response (`artifactUrl` or `imageBase64`)
   - raw image bytes (`content-type: image/*`)

3. Local fallback remains available when renderer is offline:
   - SVG data URL artifact returned to keep pipeline operational

4. `TAKUMI_API_KEY` was removed from env templates because this prototype path does not require it.

## Recommended Next Hardening

1. Split rendering into a separate process/container (`apps/images`-style) and call it from server.
2. Introduce idempotency key per render request (`claimId:version`) to prevent duplicate renders across retries.
3. Add template contract tests to verify payload compatibility and output dimensions before live coverage.
