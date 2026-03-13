// ── Text limits ────────────────────────────────────────────────────────────
export const CLAIM_TEXT_LIMIT = 484;

// ── Default evidence summaries ─────────────────────────────────────────────
export const FRED_NOT_APPLICABLE_SUMMARY = 'No economic indicator mapping required for this claim.';
export const FRED_AWAITING_SUMMARY = 'Awaiting economic evidence enrichment.';
export const CONGRESS_NOT_APPLICABLE_SUMMARY = 'No legislative evidence lookup required for this claim.';
export const CONGRESS_AWAITING_SUMMARY = 'Awaiting legislative evidence enrichment.';

// ── Pipeline timing ────────────────────────────────────────────────────────
export const RENDER_JOB_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
export const RENDER_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
export const CLAIM_STATE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
export const CLAIM_STATE_CLEANUP_INTERVAL_MS = 60 * 1000; // 1 minute

// ── Pipeline ingest ────────────────────────────────────────────────────────
export const INGEST_SAMPLE_RATE = 16000;
export const INGEST_CHANNELS = 1;
export const INGEST_BYTES_PER_SAMPLE = 2;
export const INGEST_CLOSE_WAIT_MS = 1500;
export const CLAIM_CARRYOVER_MAX_CHARS = 900;
export const CLAIM_FALLBACK_FLUSH_CHARS = 160;
export const CLAIM_RECENT_DEDUPE_TTL_MS = 10 * 60 * 1000;
export const CLAIM_RECENT_DEDUPE_MAX = 1000;
export const TRANSCRIPT_CONTEXT_CHARS = 200;
export const TRANSCRIPT_FLUSH_MAX_CHARS = 600;
export const TRANSCRIPT_FLUSH_TIMEOUT_MS = 4000;

// ── Activity store ─────────────────────────────────────────────────────────
export const ACTIVITY_BATCH_SIZE = 50;
export const ACTIVITY_MAX_QUEUE_DEPTH = 10000;

// ── SSE / event history ────────────────────────────────────────────────────
export const EVENT_HISTORY_MAX = 1000;
export const SSE_REPLAY_MAX = 200;
export const SSE_REPLAY_INITIAL = 25;
export const SSE_HEARTBEAT_INTERVAL_MS = 15000;
export const SSE_RETRY_MS = 2000;

// ── Template version ───────────────────────────────────────────────────────
export const DEFAULT_TEMPLATE_VERSION = 'fc-lower-third-v1';
export const DEFAULT_SCHEMA_VERSION = '1.0';
