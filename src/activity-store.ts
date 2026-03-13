import type { ActivityStore, PipelineEvent, RunSummary } from './types.js';

const BATCH_SIZE = 50;
const MAX_QUEUE_DEPTH = 10000;

function noop(): void {}

function sanitizeErrorMessage(message: unknown): string {
  return String(message ?? '')
    .replace(/postgres(?:ql)?:\/\/[^@\s]+@/gi, 'postgres://***@')
    .replace(/password=[^&\s]+/gi, 'password=***')
    .slice(0, 600);
}

interface QueueItem {
  kind: string;
  payload: Record<string, unknown>;
  enqueuedAt: string;
}

export function createActivityStore(options: { databaseUrl?: string; onError?: (error: Error) => void } = {}): ActivityStore {
  const databaseUrl = String(options.databaseUrl ?? '').trim();
  const onError = options.onError ?? noop;

  if (!databaseUrl) {
    return {
      init: async () => false,
      enqueueEvent: noop as (payload: PipelineEvent) => void,
      enqueueAction: noop as (payload: Record<string, unknown>) => void,
      enqueueRunStart: noop as (payload: Record<string, unknown>) => void,
      enqueueRunStop: noop as (payload: Record<string, unknown>) => void,
      enqueueClaimSnapshot: noop as (payload: Record<string, unknown>) => void,
      enqueueOutputPackage: noop as (payload: Record<string, unknown>) => void,
      enqueueRenderJob: noop as (payload: Record<string, unknown>) => void,
      loadLatestRunClaims: async () => [],
      loadRunById: async () => null,
      listRuns: async () => [],
      getStatus: () => ({ configured: false, ready: false, queueDepth: 0, lastError: null }),
    };
  }

  let pool: import('pg').Pool | null = null;
  const queue: QueueItem[] = [];
  let ready = false;
  let initializing: Promise<boolean> | null = null;
  let flushing = false;
  let lastError: string | null = null;

  function setError(stage: string, error: Error): void {
    lastError = `${stage}: ${sanitizeErrorMessage(error.message)}`;
    onError(error);
  }

  async function init(): Promise<boolean> {
    if (ready) return true;
    if (initializing) return initializing;

    initializing = (async () => {
      try {
        const pg = await import('pg');
        pool = new pg.default.Pool({
          connectionString: databaseUrl,
          ssl: { rejectUnauthorized: false },
        });

        const sqls = [
          `CREATE TABLE IF NOT EXISTS runs (run_id TEXT PRIMARY KEY, youtube_url TEXT, chunk_seconds INTEGER, model TEXT, started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), stopped_at TIMESTAMPTZ, stop_reason TEXT, organization_id TEXT DEFAULT 'default', payload JSONB NOT NULL DEFAULT '{}'::jsonb)`,
          `CREATE TABLE IF NOT EXISTS claims (claim_id TEXT PRIMARY KEY, run_id TEXT, claim_text TEXT NOT NULL, status TEXT NOT NULL, verdict TEXT NOT NULL, confidence DOUBLE PRECISION NOT NULL DEFAULT 0, claim_type_tag TEXT NOT NULL DEFAULT 'other', version INTEGER NOT NULL DEFAULT 1, output_approval_state TEXT NOT NULL DEFAULT 'pending', approved_version INTEGER, approved_at TIMESTAMPTZ, rejected_at TIMESTAMPTZ, detected_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), organization_id TEXT DEFAULT 'default', payload JSONB NOT NULL DEFAULT '{}'::jsonb)`,
          `CREATE TABLE IF NOT EXISTS activity_events (id BIGSERIAL PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), run_id TEXT, seq BIGINT, event_type TEXT NOT NULL, claim_id TEXT, organization_id TEXT DEFAULT 'default', payload JSONB NOT NULL)`,
          `CREATE TABLE IF NOT EXISTS claim_actions (id BIGSERIAL PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), run_id TEXT, claim_id TEXT NOT NULL, action TEXT NOT NULL, actor_id TEXT, reason TEXT, expected_version INTEGER, result TEXT NOT NULL, organization_id TEXT DEFAULT 'default', payload JSONB NOT NULL)`,
          `CREATE TABLE IF NOT EXISTS output_packages (package_id TEXT PRIMARY KEY, claim_id TEXT NOT NULL, run_id TEXT, status TEXT NOT NULL, template_version TEXT, payload JSONB, error TEXT, organization_id TEXT DEFAULT 'default', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
          `CREATE TABLE IF NOT EXISTS render_jobs (render_job_id TEXT PRIMARY KEY, claim_id TEXT NOT NULL, run_id TEXT, claim_version INTEGER, idempotency_key TEXT, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, artifact_url TEXT, renderer_mode TEXT, job_payload JSONB, error TEXT, organization_id TEXT DEFAULT 'default', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
          `ALTER TABLE render_jobs ADD COLUMN IF NOT EXISTS claim_version INTEGER`,
          `ALTER TABLE render_jobs ADD COLUMN IF NOT EXISTS idempotency_key TEXT`,
          `ALTER TABLE render_jobs ADD COLUMN IF NOT EXISTS job_payload JSONB`,
          // Add organization_id to existing tables (safe migration for pre-Phase 5 databases)
          `ALTER TABLE runs ADD COLUMN IF NOT EXISTS organization_id TEXT DEFAULT 'default'`,
          `ALTER TABLE claims ADD COLUMN IF NOT EXISTS organization_id TEXT DEFAULT 'default'`,
          `ALTER TABLE activity_events ADD COLUMN IF NOT EXISTS organization_id TEXT DEFAULT 'default'`,
          `ALTER TABLE claim_actions ADD COLUMN IF NOT EXISTS organization_id TEXT DEFAULT 'default'`,
          `ALTER TABLE output_packages ADD COLUMN IF NOT EXISTS organization_id TEXT DEFAULT 'default'`,
          `ALTER TABLE render_jobs ADD COLUMN IF NOT EXISTS organization_id TEXT DEFAULT 'default'`,
          `CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs (started_at DESC)`,
          `CREATE INDEX IF NOT EXISTS idx_runs_org ON runs (organization_id)`,
          `CREATE INDEX IF NOT EXISTS idx_claims_run_updated ON claims (run_id, updated_at DESC)`,
          `CREATE INDEX IF NOT EXISTS idx_claims_version ON claims (claim_id, version)`,
          `CREATE INDEX IF NOT EXISTS idx_claims_org ON claims (organization_id)`,
          `CREATE INDEX IF NOT EXISTS idx_activity_events_run_seq ON activity_events (run_id, seq)`,
          `CREATE INDEX IF NOT EXISTS idx_activity_events_org ON activity_events (organization_id)`,
          `CREATE INDEX IF NOT EXISTS idx_claim_actions_claim_created ON claim_actions (claim_id, created_at DESC)`,
          `CREATE INDEX IF NOT EXISTS idx_claim_actions_org ON claim_actions (organization_id)`,
          `CREATE INDEX IF NOT EXISTS idx_render_jobs_claim_updated ON render_jobs (claim_id, updated_at DESC)`,
          `CREATE INDEX IF NOT EXISTS idx_render_jobs_status_updated ON render_jobs (status, updated_at DESC)`,
          `CREATE UNIQUE INDEX IF NOT EXISTS uq_render_jobs_idempotency ON render_jobs (idempotency_key) WHERE idempotency_key IS NOT NULL`,
        ];

        for (const sql of sqls) {
          await pool.query(sql);
        }

        ready = true;
        lastError = null;
        return true;
      } catch (error) {
        setError('init', error as Error);
        return false;
      } finally {
        initializing = null;
      }
    })();

    return initializing;
  }

  async function executeItem(client: import('pg').PoolClient, item: QueueItem): Promise<void> {
    if (item.kind === 'event') {
      const event = item.payload;
      await client.query(
        `INSERT INTO activity_events (created_at, run_id, seq, event_type, claim_id, organization_id, payload) VALUES (COALESCE($1::timestamptz, NOW()), $2, $3, $4, $5, $6, $7::jsonb)`,
        [event.at ?? item.enqueuedAt, event.runId ?? null, event.seq ?? null, event.type ?? 'unknown', event.claimId ?? null, event.organizationId ?? 'default', JSON.stringify(event)]
      );
    } else if (item.kind === 'action') {
      const action = item.payload;
      await client.query(
        `INSERT INTO claim_actions (created_at, run_id, claim_id, action, actor_id, reason, expected_version, result, organization_id, payload) VALUES (COALESCE($1::timestamptz, NOW()), $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
        [action.at ?? item.enqueuedAt, action.runId ?? null, action.claimId, action.action, action.actorId ?? null, action.reason ?? null, Number.isInteger(action.expectedVersion) ? action.expectedVersion : null, action.result ?? 'unknown', action.organizationId ?? 'default', JSON.stringify(action)]
      );
    } else if (item.kind === 'run_start') {
      const run = item.payload;
      await client.query(
        `INSERT INTO runs (run_id, youtube_url, chunk_seconds, model, started_at, organization_id, payload) VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, NOW()), $6, $7::jsonb) ON CONFLICT (run_id) DO UPDATE SET youtube_url = EXCLUDED.youtube_url, chunk_seconds = EXCLUDED.chunk_seconds, model = EXCLUDED.model, organization_id = EXCLUDED.organization_id, payload = EXCLUDED.payload`,
        [run.runId, run.youtubeUrl ?? null, Number.isInteger(run.chunkSeconds) ? run.chunkSeconds : null, run.model ?? null, run.startedAt ?? run.at ?? item.enqueuedAt, run.organizationId ?? 'default', JSON.stringify(run)]
      );
    } else if (item.kind === 'run_stop') {
      const run = item.payload;
      await client.query(
        `INSERT INTO runs (run_id, stopped_at, stop_reason, organization_id, payload) VALUES ($1, COALESCE($2::timestamptz, NOW()), $3, $4, $5::jsonb) ON CONFLICT (run_id) DO UPDATE SET stopped_at = EXCLUDED.stopped_at, stop_reason = EXCLUDED.stop_reason, payload = runs.payload || EXCLUDED.payload`,
        [run.runId, run.stoppedAt ?? run.at ?? item.enqueuedAt, run.reason ?? null, run.organizationId ?? 'default', JSON.stringify(run)]
      );
    } else if (item.kind === 'claim_snapshot') {
      const claim = item.payload;
      await client.query(
        `INSERT INTO claims (claim_id, run_id, claim_text, status, verdict, confidence, claim_type_tag, version, output_approval_state, approved_version, approved_at, rejected_at, detected_at, updated_at, organization_id, payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,COALESCE($14::timestamptz, NOW()),$15,$16::jsonb) ON CONFLICT (claim_id) DO UPDATE SET run_id=EXCLUDED.run_id, claim_text=EXCLUDED.claim_text, status=EXCLUDED.status, verdict=EXCLUDED.verdict, confidence=EXCLUDED.confidence, claim_type_tag=EXCLUDED.claim_type_tag, version=EXCLUDED.version, output_approval_state=EXCLUDED.output_approval_state, approved_version=EXCLUDED.approved_version, approved_at=EXCLUDED.approved_at, rejected_at=EXCLUDED.rejected_at, detected_at=EXCLUDED.detected_at, updated_at=EXCLUDED.updated_at, organization_id=EXCLUDED.organization_id, payload=EXCLUDED.payload`,
        [claim.claimId, claim.runId ?? null, claim.claim ?? '', claim.status ?? 'unknown', claim.verdict ?? 'unverified', Number(claim.confidence ?? 0), claim.claimTypeTag ?? 'other', Number.isInteger(claim.version) ? claim.version : 1, claim.outputApprovalState ?? 'pending', Number.isInteger(claim.approvedVersion) ? claim.approvedVersion : null, claim.approvedAt ?? null, claim.rejectedAt ?? null, claim.detectedAt ?? claim.updatedAt ?? null, claim.updatedAt ?? claim.at ?? item.enqueuedAt, claim.organizationId ?? 'default', JSON.stringify(claim)]
      );
    } else if (item.kind === 'output_package') {
      const pkg = item.payload;
      await client.query(
        `INSERT INTO output_packages (package_id, claim_id, run_id, status, template_version, payload, error, organization_id, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,COALESCE($9::timestamptz, NOW()),COALESCE($10::timestamptz, NOW())) ON CONFLICT (package_id) DO UPDATE SET status=EXCLUDED.status, template_version=EXCLUDED.template_version, payload=EXCLUDED.payload, error=EXCLUDED.error, organization_id=EXCLUDED.organization_id, updated_at=EXCLUDED.updated_at`,
        [pkg.packageId, pkg.claimId, pkg.runId ?? null, pkg.status ?? 'unknown', pkg.templateVersion ?? null, JSON.stringify(pkg.payload ?? null), pkg.error ?? null, pkg.organizationId ?? 'default', pkg.createdAt ?? item.enqueuedAt, pkg.updatedAt ?? item.enqueuedAt]
      );
    } else if (item.kind === 'render_job') {
      const job = item.payload;
      await client.query(
        `INSERT INTO render_jobs (render_job_id, claim_id, run_id, claim_version, idempotency_key, status, attempts, artifact_url, renderer_mode, job_payload, error, organization_id, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,COALESCE($13::timestamptz, NOW()),COALESCE($14::timestamptz, NOW())) ON CONFLICT (render_job_id) DO UPDATE SET claim_version=EXCLUDED.claim_version, idempotency_key=EXCLUDED.idempotency_key, status=EXCLUDED.status, attempts=EXCLUDED.attempts, artifact_url=EXCLUDED.artifact_url, renderer_mode=EXCLUDED.renderer_mode, job_payload=EXCLUDED.job_payload, error=EXCLUDED.error, organization_id=EXCLUDED.organization_id, updated_at=EXCLUDED.updated_at`,
        [job.renderJobId, job.claimId, job.runId ?? null, Number.isInteger(job.claimVersion) ? job.claimVersion : null, job.idempotencyKey ?? null, job.status ?? 'unknown', Number.isInteger(job.attempts) ? job.attempts : 0, job.artifactUrl ?? null, job.rendererMode ?? null, JSON.stringify(job.claim ?? null), job.error ?? null, job.organizationId ?? 'default', job.createdAt ?? item.enqueuedAt, job.updatedAt ?? item.enqueuedAt]
      );
    }
  }

  async function flushQueue(): Promise<void> {
    if (flushing || queue.length === 0) return;
    if (!ready) {
      const ok = await init();
      if (!ok) return;
    }

    flushing = true;
    const batch = queue.splice(0, BATCH_SIZE);

    // Group by kind so each entity type flushes in its own transaction
    const byKind = new Map<string, QueueItem[]>();
    for (const item of batch) {
      const group = byKind.get(item.kind);
      if (group) group.push(item);
      else byKind.set(item.kind, [item]);
    }

    const failedItems: QueueItem[] = [];
    for (const [, items] of byKind) {
      let client: import('pg').PoolClient | null = null;
      try {
        client = await pool!.connect();
        await client.query('BEGIN');
        for (const item of items) {
          await executeItem(client, item);
        }
        await client.query('COMMIT');
      } catch (error) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        failedItems.push(...items);
        setError('flush', error as Error);
      } finally {
        client?.release();
      }
    }

    if (failedItems.length > 0) queue.unshift(...failedItems);
    flushing = false;
    if (queue.length > 0) {
      setTimeout(() => { void flushQueue(); }, 80);
    }
  }

  function enqueue(kind: string, payload: Record<string, unknown>): void {
    if (queue.length >= MAX_QUEUE_DEPTH) {
      queue.shift();
      lastError = `queue_overflow: queue reached ${MAX_QUEUE_DEPTH}, dropped oldest activity item`;
    }
    queue.push({ kind, payload, enqueuedAt: new Date().toISOString() });
    void flushQueue();
  }

  async function ensureReady(): Promise<boolean> {
    if (ready) return true;
    return init();
  }

  return {
    init,
    enqueueEvent(payload) { enqueue('event', payload as Record<string, unknown>); },
    enqueueAction(payload) { enqueue('action', payload); },
    enqueueRunStart(payload) { enqueue('run_start', payload); },
    enqueueRunStop(payload) { enqueue('run_stop', payload); },
    enqueueClaimSnapshot(payload) { enqueue('claim_snapshot', payload); },
    enqueueOutputPackage(payload) { enqueue('output_package', payload); },
    enqueueRenderJob(payload) { enqueue('render_job', payload); },
    async loadLatestRunClaims(limit = 500) {
      if (!(await ensureReady())) return [];
      try {
        const runResult = await pool!.query(`SELECT run_id FROM runs ORDER BY started_at DESC LIMIT 1`);
        const runRow = runResult.rows[0] as { run_id?: string } | undefined;
        if (!runRow?.run_id) return [];
        const maxRows = Math.max(1, Math.min(5000, Number(limit) || 500));
        const claimsResult = await pool!.query(`SELECT payload FROM claims WHERE run_id = $1 ORDER BY updated_at DESC LIMIT $2`, [runRow.run_id, maxRows]);
        return claimsResult.rows.map((row: Record<string, unknown>) => row.payload as Record<string, unknown>).filter((row) => row && typeof row === 'object');
      } catch (error) {
        setError('load_latest_run_claims', error as Error);
        return [];
      }
    },
    async loadRunById(runId) {
      if (!(await ensureReady()) || !runId) return null;
      try {
        const result = await pool!.query(`SELECT run_id, youtube_url, chunk_seconds, model, started_at, stopped_at, stop_reason, payload FROM runs WHERE run_id = $1 LIMIT 1`, [runId]);
        return (result.rows[0] as Record<string, unknown>) ?? null;
      } catch (error) {
        setError('load_run_by_id', error as Error);
        return null;
      }
    },
    async listRuns(): Promise<RunSummary[]> {
      if (!(await ensureReady())) return [];
      try {
        const result = await pool!.query(
          `SELECT r.run_id, r.youtube_url, r.started_at, r.stopped_at, r.stop_reason, COUNT(c.claim_id)::int AS claim_count FROM runs r LEFT JOIN claims c ON c.run_id = r.run_id GROUP BY r.run_id ORDER BY r.started_at DESC`
        );
        return result.rows.map((row: Record<string, unknown>) => ({
          runId: row.run_id as string,
          youtubeUrl: (row.youtube_url as string) ?? null,
          startedAt: (row.started_at as Date).toISOString(),
          stoppedAt: row.stopped_at ? (row.stopped_at as Date).toISOString() : null,
          stopReason: (row.stop_reason as string) ?? null,
          claimCount: (row.claim_count as number) ?? 0,
        }));
      } catch (error) {
        setError('list_runs', error as Error);
        return [];
      }
    },
    getStatus() {
      return { configured: true, ready, queueDepth: queue.length, lastError };
    },
  };
}
