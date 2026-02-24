const BATCH_SIZE = 50;
const MAX_QUEUE_DEPTH = 10000;

function noop() {}

function sanitizeErrorMessage(message) {
  return String(message ?? '')
    .replace(/postgres(?:ql)?:\/\/[^@\s]+@/gi, 'postgres://***@')
    .replace(/password=[^&\s]+/gi, 'password=***')
    .slice(0, 600);
}

export function createActivityStore(options = {}) {
  const databaseUrl = String(options.databaseUrl ?? '').trim();
  const onError = options.onError ?? noop;

  if (!databaseUrl) {
    return {
      init: async () => false,
      enqueueEvent: noop,
      enqueueAction: noop,
      enqueueRunStart: noop,
      enqueueRunStop: noop,
      enqueueClaimSnapshot: noop,
      enqueueOutputPackage: noop,
      enqueueRenderJob: noop,
      loadLatestRunClaims: async () => [],
      loadRunById: async () => null,
      getStatus: () => ({
        configured: false,
        ready: false,
        queueDepth: 0,
        lastError: null
      })
    };
  }

  let pool = null;

  const queue = [];
  let ready = false;
  let initializing = null;
  let flushing = false;
  let lastError = null;

  function setError(stage, error) {
    lastError = `${stage}: ${sanitizeErrorMessage(error.message)}`;
    onError(error);
  }

  async function init() {
    if (ready) {
      return true;
    }

    if (initializing) {
      return initializing;
    }

    initializing = (async () => {
      try {
        let PoolCtor;
        try {
          ({ Pool: PoolCtor } = await import('pg'));
        } catch (error) {
          setError(
            'init',
            new Error(
              `DATABASE_URL is set but package "pg" is not installed. Run "npm install" before enabling Neon logging. (${error.message})`
            )
          );
          return false;
        }

        pool = new PoolCtor({
          connectionString: databaseUrl,
          ssl: {
            rejectUnauthorized: false
          }
        });

        await pool.query(`
          CREATE TABLE IF NOT EXISTS runs (
            run_id TEXT PRIMARY KEY,
            youtube_url TEXT,
            chunk_seconds INTEGER,
            model TEXT,
            started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            stopped_at TIMESTAMPTZ,
            stop_reason TEXT,
            payload JSONB NOT NULL DEFAULT '{}'::jsonb
          );
        `);

        await pool.query(`
          CREATE TABLE IF NOT EXISTS claims (
            claim_id TEXT PRIMARY KEY,
            run_id TEXT,
            claim_text TEXT NOT NULL,
            status TEXT NOT NULL,
            verdict TEXT NOT NULL,
            confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
            claim_type_tag TEXT NOT NULL DEFAULT 'other',
            version INTEGER NOT NULL DEFAULT 1,
            output_approval_state TEXT NOT NULL DEFAULT 'pending',
            approved_version INTEGER,
            approved_at TIMESTAMPTZ,
            rejected_at TIMESTAMPTZ,
            detected_at TIMESTAMPTZ,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            payload JSONB NOT NULL DEFAULT '{}'::jsonb
          );
        `);

        await pool.query(`
          CREATE TABLE IF NOT EXISTS activity_events (
            id BIGSERIAL PRIMARY KEY,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            run_id TEXT,
            seq BIGINT,
            event_type TEXT NOT NULL,
            claim_id TEXT,
            payload JSONB NOT NULL
          );
        `);

        await pool.query(`
          CREATE TABLE IF NOT EXISTS claim_actions (
            id BIGSERIAL PRIMARY KEY,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            run_id TEXT,
            claim_id TEXT NOT NULL,
            action TEXT NOT NULL,
            actor_id TEXT,
            reason TEXT,
            expected_version INTEGER,
            result TEXT NOT NULL,
            payload JSONB NOT NULL
          );
        `);

        await pool.query(`
          CREATE TABLE IF NOT EXISTS output_packages (
            package_id TEXT PRIMARY KEY,
            claim_id TEXT NOT NULL,
            run_id TEXT,
            status TEXT NOT NULL,
            template_version TEXT,
            payload JSONB,
            error TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `);

        await pool.query(`
          CREATE TABLE IF NOT EXISTS render_jobs (
            render_job_id TEXT PRIMARY KEY,
            claim_id TEXT NOT NULL,
            run_id TEXT,
            claim_version INTEGER,
            idempotency_key TEXT,
            status TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            artifact_url TEXT,
            renderer_mode TEXT,
            job_payload JSONB,
            error TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `);

        await pool.query(`
          ALTER TABLE render_jobs
          ADD COLUMN IF NOT EXISTS claim_version INTEGER;
        `);

        await pool.query(`
          ALTER TABLE render_jobs
          ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
        `);

        await pool.query(`
          ALTER TABLE render_jobs
          ADD COLUMN IF NOT EXISTS job_payload JSONB;
        `);

        await pool.query(`
          CREATE INDEX IF NOT EXISTS idx_runs_started_at
          ON runs (started_at DESC);
        `);

        await pool.query(`
          CREATE INDEX IF NOT EXISTS idx_claims_run_updated
          ON claims (run_id, updated_at DESC);
        `);

        await pool.query(`
          CREATE INDEX IF NOT EXISTS idx_claims_version
          ON claims (claim_id, version);
        `);

        await pool.query(`
          CREATE INDEX IF NOT EXISTS idx_activity_events_run_seq
          ON activity_events (run_id, seq);
        `);

        await pool.query(`
          CREATE INDEX IF NOT EXISTS idx_claim_actions_claim_created
          ON claim_actions (claim_id, created_at DESC);
        `);

        await pool.query(`
          CREATE INDEX IF NOT EXISTS idx_render_jobs_claim_updated
          ON render_jobs (claim_id, updated_at DESC);
        `);

        await pool.query(`
          CREATE INDEX IF NOT EXISTS idx_render_jobs_status_updated
          ON render_jobs (status, updated_at DESC);
        `);

        await pool.query(`
          CREATE UNIQUE INDEX IF NOT EXISTS uq_render_jobs_idempotency
          ON render_jobs (idempotency_key)
          WHERE idempotency_key IS NOT NULL;
        `);

        ready = true;
        lastError = null;
        return true;
      } catch (error) {
        setError('init', error);
        return false;
      } finally {
        initializing = null;
      }
    })();

    return initializing;
  }

  async function flushQueue() {
    if (flushing || queue.length === 0) {
      return;
    }

    if (!ready) {
      const ok = await init();
      if (!ok) {
        return;
      }
    }

    flushing = true;
    const batch = queue.splice(0, BATCH_SIZE);
    let client = null;
    try {
      client = await pool.connect();
      await client.query('BEGIN');

      for (const item of batch) {
        if (item.kind === 'event') {
          const event = item.payload;
          await client.query(
            `
              INSERT INTO activity_events (
                created_at, run_id, seq, event_type, claim_id, payload
              )
              VALUES (
                COALESCE($1::timestamptz, NOW()),
                $2,
                $3,
                $4,
                $5,
                $6::jsonb
              )
            `,
            [
              event.at ?? item.enqueuedAt,
              event.runId ?? null,
              event.seq ?? null,
              event.type ?? 'unknown',
              event.claimId ?? null,
              JSON.stringify(event)
            ]
          );
          continue;
        }

        if (item.kind === 'action') {
          const action = item.payload;
          await client.query(
            `
              INSERT INTO claim_actions (
                created_at, run_id, claim_id, action, actor_id, reason, expected_version, result, payload
              )
              VALUES (
                COALESCE($1::timestamptz, NOW()),
                $2,
                $3,
                $4,
                $5,
                $6,
                $7,
                $8,
                $9::jsonb
              )
            `,
            [
              action.at ?? item.enqueuedAt,
              action.runId ?? null,
              action.claimId,
              action.action,
              action.actorId ?? null,
              action.reason ?? null,
              Number.isInteger(action.expectedVersion) ? action.expectedVersion : null,
              action.result ?? 'unknown',
              JSON.stringify(action)
            ]
          );
          continue;
        }

        if (item.kind === 'run_start') {
          const run = item.payload;
          await client.query(
            `
              INSERT INTO runs (
                run_id, youtube_url, chunk_seconds, model, started_at, payload
              )
              VALUES (
                $1, $2, $3, $4, COALESCE($5::timestamptz, NOW()), $6::jsonb
              )
              ON CONFLICT (run_id)
              DO UPDATE SET
                youtube_url = EXCLUDED.youtube_url,
                chunk_seconds = EXCLUDED.chunk_seconds,
                model = EXCLUDED.model,
                payload = EXCLUDED.payload
            `,
            [
              run.runId,
              run.youtubeUrl ?? null,
              Number.isInteger(run.chunkSeconds) ? run.chunkSeconds : null,
              run.model ?? null,
              run.startedAt ?? run.at ?? item.enqueuedAt,
              JSON.stringify(run)
            ]
          );
          continue;
        }

        if (item.kind === 'run_stop') {
          const run = item.payload;
          await client.query(
            `
              INSERT INTO runs (
                run_id, stopped_at, stop_reason, payload
              )
              VALUES (
                $1, COALESCE($2::timestamptz, NOW()), $3, $4::jsonb
              )
              ON CONFLICT (run_id)
              DO UPDATE SET
                stopped_at = EXCLUDED.stopped_at,
                stop_reason = EXCLUDED.stop_reason,
                payload = runs.payload || EXCLUDED.payload
            `,
            [
              run.runId,
              run.stoppedAt ?? run.at ?? item.enqueuedAt,
              run.reason ?? null,
              JSON.stringify(run)
            ]
          );
          continue;
        }

        if (item.kind === 'claim_snapshot') {
          const claim = item.payload;
          await client.query(
            `
              INSERT INTO claims (
                claim_id,
                run_id,
                claim_text,
                status,
                verdict,
                confidence,
                claim_type_tag,
                version,
                output_approval_state,
                approved_version,
                approved_at,
                rejected_at,
                detected_at,
                updated_at,
                payload
              )
              VALUES (
                $1,
                $2,
                $3,
                $4,
                $5,
                $6,
                $7,
                $8,
                $9,
                $10,
                $11,
                $12,
                $13,
                COALESCE($14::timestamptz, NOW()),
                $15::jsonb
              )
              ON CONFLICT (claim_id)
              DO UPDATE SET
                run_id = EXCLUDED.run_id,
                claim_text = EXCLUDED.claim_text,
                status = EXCLUDED.status,
                verdict = EXCLUDED.verdict,
                confidence = EXCLUDED.confidence,
                claim_type_tag = EXCLUDED.claim_type_tag,
                version = EXCLUDED.version,
                output_approval_state = EXCLUDED.output_approval_state,
                approved_version = EXCLUDED.approved_version,
                approved_at = EXCLUDED.approved_at,
                rejected_at = EXCLUDED.rejected_at,
                detected_at = EXCLUDED.detected_at,
                updated_at = EXCLUDED.updated_at,
                payload = EXCLUDED.payload
            `,
            [
              claim.claimId,
              claim.runId ?? null,
              claim.claim ?? '',
              claim.status ?? 'unknown',
              claim.verdict ?? 'unverified',
              Number(claim.confidence ?? 0),
              claim.claimTypeTag ?? 'other',
              Number.isInteger(claim.version) ? claim.version : 1,
              claim.outputApprovalState ?? 'pending',
              Number.isInteger(claim.approvedVersion) ? claim.approvedVersion : null,
              claim.approvedAt ?? null,
              claim.rejectedAt ?? null,
              claim.detectedAt ?? claim.updatedAt ?? null,
              claim.updatedAt ?? claim.at ?? item.enqueuedAt,
              JSON.stringify(claim)
            ]
          );
          continue;
        }

        if (item.kind === 'output_package') {
          const pkg = item.payload;
          await client.query(
            `
              INSERT INTO output_packages (
                package_id, claim_id, run_id, status, template_version, payload, error, created_at, updated_at
              )
              VALUES (
                $1, $2, $3, $4, $5, $6::jsonb, $7, COALESCE($8::timestamptz, NOW()), COALESCE($9::timestamptz, NOW())
              )
              ON CONFLICT (package_id)
              DO UPDATE SET
                status = EXCLUDED.status,
                template_version = EXCLUDED.template_version,
                payload = EXCLUDED.payload,
                error = EXCLUDED.error,
                updated_at = EXCLUDED.updated_at
            `,
            [
              pkg.packageId,
              pkg.claimId,
              pkg.runId ?? null,
              pkg.status ?? 'unknown',
              pkg.templateVersion ?? null,
              JSON.stringify(pkg.payload ?? null),
              pkg.error ?? null,
              pkg.createdAt ?? item.enqueuedAt,
              pkg.updatedAt ?? item.enqueuedAt
            ]
          );
          continue;
        }

        if (item.kind === 'render_job') {
          const job = item.payload;
          await client.query(
            `
              INSERT INTO render_jobs (
                render_job_id,
                claim_id,
                run_id,
                claim_version,
                idempotency_key,
                status,
                attempts,
                artifact_url,
                renderer_mode,
                job_payload,
                error,
                created_at,
                updated_at
              )
              VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, COALESCE($12::timestamptz, NOW()), COALESCE($13::timestamptz, NOW())
              )
              ON CONFLICT (render_job_id)
              DO UPDATE SET
                claim_version = EXCLUDED.claim_version,
                idempotency_key = EXCLUDED.idempotency_key,
                status = EXCLUDED.status,
                attempts = EXCLUDED.attempts,
                artifact_url = EXCLUDED.artifact_url,
                renderer_mode = EXCLUDED.renderer_mode,
                job_payload = EXCLUDED.job_payload,
                error = EXCLUDED.error,
                updated_at = EXCLUDED.updated_at
            `,
            [
              job.renderJobId,
              job.claimId,
              job.runId ?? null,
              Number.isInteger(job.claimVersion) ? job.claimVersion : null,
              job.idempotencyKey ?? null,
              job.status ?? 'unknown',
              Number.isInteger(job.attempts) ? job.attempts : 0,
              job.artifactUrl ?? null,
              job.rendererMode ?? null,
              JSON.stringify(job.claim ?? null),
              job.error ?? null,
              job.createdAt ?? item.enqueuedAt,
              job.updatedAt ?? item.enqueuedAt
            ]
          );
        }
      }

      await client.query('COMMIT');
    } catch (error) {
      if (client) {
        await client.query('ROLLBACK').catch(() => {});
      }
      queue.unshift(...batch);
      setError('flush', error);
    } finally {
      client?.release();
      flushing = false;
      if (queue.length > 0) {
        setTimeout(() => {
          void flushQueue();
        }, 80);
      }
    }
  }

  function enqueue(kind, payload) {
    if (queue.length >= MAX_QUEUE_DEPTH) {
      queue.shift();
      lastError = `queue_overflow: queue reached ${MAX_QUEUE_DEPTH}, dropped oldest activity item`;
    }

    queue.push({
      kind,
      payload,
      enqueuedAt: new Date().toISOString()
    });
    void flushQueue();
  }

  async function ensureReady() {
    if (ready) {
      return true;
    }
    return init();
  }

  return {
    init,
    enqueueEvent(payload) {
      enqueue('event', payload);
    },
    enqueueAction(payload) {
      enqueue('action', payload);
    },
    enqueueRunStart(payload) {
      enqueue('run_start', payload);
    },
    enqueueRunStop(payload) {
      enqueue('run_stop', payload);
    },
    enqueueClaimSnapshot(payload) {
      enqueue('claim_snapshot', payload);
    },
    enqueueOutputPackage(payload) {
      enqueue('output_package', payload);
    },
    enqueueRenderJob(payload) {
      enqueue('render_job', payload);
    },
    async loadLatestRunClaims(limit = 500) {
      if (!(await ensureReady())) {
        return [];
      }

      try {
        const runResult = await pool.query(
          `
            SELECT run_id
            FROM runs
            ORDER BY started_at DESC
            LIMIT 1
          `
        );
        const runRow = runResult.rows[0];
        if (!runRow?.run_id) {
          return [];
        }

        const maxRows = Math.max(1, Math.min(5000, Number(limit) || 500));
        const claimsResult = await pool.query(
          `
            SELECT payload
            FROM claims
            WHERE run_id = $1
            ORDER BY updated_at DESC
            LIMIT $2
          `,
          [runRow.run_id, maxRows]
        );

        return claimsResult.rows
          .map((row) => row.payload)
          .filter((row) => row && typeof row === 'object');
      } catch (error) {
        setError('load_latest_run_claims', error);
        return [];
      }
    },
    async loadRunById(runId) {
      if (!(await ensureReady()) || !runId) {
        return null;
      }

      try {
        const result = await pool.query(
          `
            SELECT run_id, youtube_url, chunk_seconds, model, started_at, stopped_at, stop_reason, payload
            FROM runs
            WHERE run_id = $1
            LIMIT 1
          `,
          [runId]
        );
        return result.rows[0] ?? null;
      } catch (error) {
        setError('load_run_by_id', error);
        return null;
      }
    },
    getStatus() {
      return {
        configured: true,
        ready,
        queueDepth: queue.length,
        lastError
      };
    }
  };
}
