import path from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';

import * as claimState from '../claim-state.js';
import type { PipelineEvent, PipelineInstance, ActivityStore } from '../types.js';
import type { PipelineRegistry, PipelineEntry } from '../pipeline-registry.js';
import type { OutputPackageService } from '../output-package-service.js';
import type { RenderService } from '../render-service.js';
import type { SseManager } from './sse.js';
import { withPolicy, buildClaimEventPayload, nextClaimVersion, policyBlockMessage } from './claim-events.js';

export interface RoutesDeps {
  env: Record<string, unknown>;
  pipelineRegistry: PipelineRegistry;
  activityStore: ActivityStore;
  outputPackageService: OutputPackageService;
  renderService: RenderService;
  sseManager: SseManager;
  eventHistory: PipelineEvent[];
  emitEvent: (event: PipelineEvent) => void;
  getActivePipeline: () => PipelineInstance | null;
  getCurrentRunId: () => string | null;
  getCurrentOverlayKey: () => string | null;
  setDefaultPipelineId: (id: string | null) => void;
  setCurrentOverlayKey: (key: string | null) => void;
  setCurrentYoutubeUrl: (url: string | null) => void;
  setCurrentStartedAt: (at: string | null) => void;
}

function parseExpectedVersion(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function isValidClaimTypeTag(tag: string): boolean {
  return tag === 'numeric_factual' || tag === 'simple_policy' || tag === 'other';
}

function isValidYoutubeUrl(value: string): boolean {
  try { const parsed = new URL(value); return ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(parsed.hostname.toLowerCase()); } catch { return false; }
}

export async function registerRoutes(app: FastifyInstance, deps: RoutesDeps): Promise<void> {
  const { env, pipelineRegistry, activityStore, outputPackageService, renderService, emitEvent, getActivePipeline, getCurrentRunId, getCurrentOverlayKey } = deps;

  function logClaimAction(payload: Record<string, unknown>): void {
    activityStore.enqueueAction({ at: new Date().toISOString(), ...payload });
  }

  // ── Health & auth ──────────────────────────────────────────────────────

  app.get('/health', async () => {
    const activePipeline = getActivePipeline();
    const dbStatus = activityStore.getStatus();
    const pipelineStatus = activePipeline?.getStatus() ?? null;
    return {
      ok: true, running: Boolean(activePipeline?.isRunning()), runId: getCurrentRunId(), overlayKey: getCurrentOverlayKey(),
      pipelineCount: pipelineRegistry.size(), claimCount: claimState.claimCount(),
      hasGeminiKey: Boolean(env.GEMINI_API_KEY), hasGoogleFactCheckKey: Boolean(env.GOOGLE_FACT_CHECK_API_KEY),
      hasFredKey: Boolean(env.FRED_API_KEY), hasCongressKey: Boolean(env.CONGRESS_API_KEY),
      hasTakumiRenderer: Boolean(env.TAKUMI_RENDER_URL), authRequired: Boolean(env.CONTROL_PASSWORD),
      protectReadEndpoints: env.PROTECT_READ_ENDPOINTS, controlRateLimitPerMin: env.CONTROL_RATE_LIMIT_PER_MIN,
      maxResearchConcurrency: env.MAX_RESEARCH_CONCURRENCY, claimDetectionThreshold: env.CLAIM_DETECTION_THRESHOLD,
      ingestState: pipelineStatus?.ingestState ?? 'stopped', reconnectAttempt: pipelineStatus?.reconnectAttempt ?? 0,
      ingestReconnectEnabled: pipelineStatus?.reconnectEnabled ?? env.INGEST_RECONNECT_ENABLED,
      ingestMaxRetries: pipelineStatus?.maxRetries ?? env.INGEST_MAX_RETRIES,
      ingestRetryBaseMs: env.INGEST_RETRY_BASE_MS, ingestRetryMaxMs: env.INGEST_RETRY_MAX_MS,
      ingestStallTimeoutMs: env.INGEST_STALL_TIMEOUT_MS, ingestVerboseLogs: env.INGEST_VERBOSE_LOGS,
      lastIngestExit: pipelineStatus?.lastIngestExit ?? null, lastIngestEventAt: pipelineStatus?.lastIngestEventAt ?? null,
      database: dbStatus,
    };
  });

  app.get('/auth-status', async () => ({
    ok: true, authRequired: Boolean(env.CONTROL_PASSWORD), protectReadEndpoints: env.PROTECT_READ_ENDPOINTS, controlRateLimitPerMin: env.CONTROL_RATE_LIMIT_PER_MIN,
  }));

  // ── Claims & runs ──────────────────────────────────────────────────────

  app.get('/api/claims', async (request) => {
    const queryRunId = (request.query as Record<string, string>)?.runId ?? null;
    const claims = queryRunId ? claimState.getClaimsForRun(queryRunId) : claimState.getClaimsSorted();
    const runningFlag = queryRunId
      ? Boolean(pipelineRegistry.getByRunId(queryRunId)?.pipeline.isRunning())
      : Boolean(getActivePipeline()?.isRunning());
    return { ok: true, running: runningFlag, runId: queryRunId ?? getCurrentRunId(), claims };
  });

  app.get('/api/runs', async () => {
    const runs = await activityStore.listRuns();
    for (const entry of pipelineRegistry.list()) {
      if (entry.pipeline.isRunning() && !runs.some(r => r.runId === entry.runId)) {
        runs.unshift({
          runId: entry.runId,
          youtubeUrl: entry.youtubeUrl,
          startedAt: entry.createdAt,
          stoppedAt: null,
          stopReason: null,
          claimCount: claimState.getClaimsForRun(entry.runId).length,
        });
      }
    }
    return { ok: true, runs };
  });

  app.get('/api/output-packages', async (request) => {
    const runId = (request.query as Record<string, string>)?.runId ?? null;
    return { ok: true, packages: outputPackageService.listByRunId(runId) };
  });

  app.get<{ Params: { claimId: string } }>('/api/claims/:claimId/output-package', async (request, reply) => {
    const claimId = request.params.claimId;
    const outputPackage = outputPackageService.getByClaimId(claimId);
    if (!outputPackage) return reply.status(404).send({ ok: false, error: `No output package found for claim: ${claimId}` });
    return { ok: true, package: outputPackage };
  });

  app.get<{ Params: { claimId: string } }>('/api/claims/:claimId/render-job', async (request, reply) => {
    const claimId = request.params.claimId;
    const renderJob = renderService.getByClaimId(claimId);
    if (!renderJob) return reply.status(404).send({ ok: false, error: `No render job found for claim: ${claimId}` });
    return { ok: true, renderJob };
  });

  app.get<{ Params: { claimId: string } }>('/api/claims/:claimId/export-image', async (request, reply) => {
    const claimId = request.params.claimId;
    const renderJob = renderService.getByClaimId(claimId);
    if (!renderJob || renderJob.status !== 'ready' || !renderJob.artifactUrl) {
      return reply.status(404).send({ ok: false, error: `No ready render found for claim: ${claimId}` });
    }
    const url = renderJob.artifactUrl;
    if (url.startsWith('data:image/png;base64,')) {
      const raw = Buffer.from(url.slice('data:image/png;base64,'.length), 'base64');
      return reply.header('Content-Type', 'image/png').header('Content-Disposition', `inline; filename="factcheck-${claimId}.png"`).send(raw);
    }
    if (url.startsWith('data:image/svg+xml;base64,')) {
      const raw = Buffer.from(url.slice('data:image/svg+xml;base64,'.length), 'base64');
      return reply.header('Content-Type', 'image/svg+xml').header('Content-Disposition', `inline; filename="factcheck-${claimId}.svg"`).send(raw);
    }
    return reply.redirect(url);
  });

  // ── SSE endpoint ───────────────────────────────────────────────────────

  app.get('/events', async (request, reply) => {
    const raw = reply.raw;
    reply.hijack();
    const lastEventIdRaw = request.headers['last-event-id'];
    const lastEventId = typeof lastEventIdRaw === 'string' ? Number.parseInt(lastEventIdRaw, 10) : Number.NaN;
    deps.sseManager.addClient(raw, Number.isInteger(lastEventId) ? lastEventId : null, deps.eventHistory);
  });

  // ── Pipeline start/stop ────────────────────────────────────────────────

  app.post('/api/start', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const youtubeUrl = String(body.youtubeUrl ?? '').trim();
    const speechContext = String(body.speechContext ?? env.SPEECH_CONTEXT).trim();
    const operatorNotes = String(body.operatorNotes ?? env.OPERATOR_NOTES).trim();

    if (!isValidYoutubeUrl(youtubeUrl)) {
      const hint = isValidYoutubeUrl(speechContext) ? ' It looks like the YouTube URL was entered in the speech context field.' : '';
      return reply.status(400).send({ ok: false, error: 'A valid YouTube URL is required.' + hint });
    }
    outputPackageService.clear(); renderService.clear();

    const pipelineConfig = {
      youtubeUrl, geminiApiKey: env.GEMINI_API_KEY as string, geminiModel: env.GEMINI_TRANSCRIBE_MODEL as string,
      factCheckApiKey: env.GOOGLE_FACT_CHECK_API_KEY as string, fredApiKey: env.FRED_API_KEY as string,
      congressApiKey: env.CONGRESS_API_KEY as string, chunkSeconds: env.CHUNK_SECONDS as number,
      maxResearchConcurrency: env.MAX_RESEARCH_CONCURRENCY as number, claimDetectionThreshold: env.CLAIM_DETECTION_THRESHOLD as number,
      ingestReconnectEnabled: env.INGEST_RECONNECT_ENABLED as boolean, ingestMaxRetries: env.INGEST_MAX_RETRIES as number,
      ingestRetryBaseMs: env.INGEST_RETRY_BASE_MS as number, ingestRetryMaxMs: env.INGEST_RETRY_MAX_MS as number,
      ingestStallTimeoutMs: env.INGEST_STALL_TIMEOUT_MS as number, ingestVerboseLogs: env.INGEST_VERBOSE_LOGS as boolean,
      geminiVerifyModel: env.GEMINI_VERIFY_MODEL as string, speechContext, operatorNotes, onEvent: emitEvent,
    };

    let entry: PipelineEntry;
    try {
      entry = pipelineRegistry.start(randomUUID(), pipelineConfig);
    } catch (error) {
      return reply.status(500).send({ ok: false, error: (error as Error).message });
    }

    deps.setDefaultPipelineId(entry.pipelineId);
    deps.setCurrentOverlayKey(entry.overlayKey);
    deps.setCurrentYoutubeUrl(youtubeUrl);
    deps.setCurrentStartedAt(entry.createdAt);

    entry.outputPackageService.setEventHandler(emitEvent);
    entry.renderService.setEventHandler(emitEvent);
    entry.renderService.setJobUpdateHandler((job) => { activityStore.enqueueRenderJob(job as unknown as Record<string, unknown>); });

    return reply.status(202).send({ ok: true, runId: entry.runId, overlayKey: entry.overlayKey });
  });

  app.post('/api/stop', async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const targetRunId = typeof body.runId === 'string' ? body.runId.trim() : null;

    if (targetRunId) {
      const entry = pipelineRegistry.getByRunId(targetRunId);
      if (entry?.pipeline.isRunning()) {
        try { entry.pipeline.stop('user_requested_stop'); } catch { /* logged by pipeline */ }
      }
    } else {
      const activePipeline = getActivePipeline();
      if (activePipeline?.isRunning()) {
        try { activePipeline.stop('user_requested_stop'); } catch { /* logged by pipeline */ }
      }
    }
    return { ok: true, running: pipelineRegistry.list().some(e => e.pipeline.isRunning()) };
  });

  app.get('/api/pipelines', async () => ({
    ok: true,
    pipelines: pipelineRegistry.list().map((entry) => ({
      pipelineId: entry.pipelineId,
      runId: entry.runId,
      overlayKey: entry.overlayKey,
      running: entry.pipeline.isRunning(),
      createdAt: entry.createdAt,
      status: entry.pipeline.getStatus(),
    })),
  }));

  // ── Claim actions ──────────────────────────────────────────────────────

  app.post<{ Params: { claimId: string; action: string } }>('/api/claims/:claimId/:action', async (request, reply) => {
    const { claimId, action } = request.params;
    const validActions = ['approve-output', 'reject-output', 'generate-package', 'render-image', 'tag-override'];
    if (!validActions.includes(action)) return reply.status(404).send({ ok: false, error: `Unsupported claim action: ${action}` });

    const body = (request.body ?? {}) as Record<string, unknown>;
    const existingRaw = claimState.getClaim(claimId);
    const existing = existingRaw ? withPolicy(existingRaw) : null;
    const actorId = typeof request.headers['x-operator-id'] === 'string' && (request.headers['x-operator-id'] as string).trim() ? (request.headers['x-operator-id'] as string).trim().slice(0, 120) : 'operator-unknown';
    const reason = typeof body.reason === 'string' && (body.reason as string).trim() ? (body.reason as string).trim().slice(0, 600) : null;
    const expectedVersion = parseExpectedVersion(body.expectedVersion);
    const logResult = (result: string, extra: Record<string, unknown> = {}) => { logClaimAction({ runId: existing?.runId ?? getCurrentRunId() ?? null, claimId, action, actorId, reason, expectedVersion, result, ...extra }); };

    if (!existing) { logResult('failed_not_found'); return reply.status(404).send({ ok: false, error: `Claim not found: ${claimId}` }); }
    if (expectedVersion === null) { logResult('failed_missing_expected_version', { currentVersion: existing.version }); return reply.status(400).send({ ok: false, error: 'expectedVersion is required for claim actions to prevent stale mutations.' }); }
    if (expectedVersion !== existing.version) { logResult('failed_version_conflict', { currentVersion: existing.version }); return reply.status(409).send({ ok: false, error: `Claim state changed. Expected version=${expectedVersion}, current=${existing.version}.` }); }

    if (action === 'tag-override') {
      const requestedTag = typeof body.tag === 'string' ? (body.tag as string).trim().toLowerCase() : '';
      if (!isValidClaimTypeTag(requestedTag)) { logResult('failed_invalid_tag', { providedTag: requestedTag || null }); return reply.status(400).send({ ok: false, error: 'Tag must be one of: numeric_factual, simple_policy, other.' }); }
      if (!reason) { logResult('failed_missing_reason'); return reply.status(400).send({ ok: false, error: 'A non-empty reason is required for tag override.' }); }
      if (existing.outputApprovalState === 'approved') { logResult('failed_approved_locked'); return reply.status(409).send({ ok: false, error: 'Claim is already approved. Reject output first before changing policy classification.' }); }
      emitEvent(buildClaimEventPayload('claim.updated', existing, { claimTypeTag: requestedTag, claimTypeConfidence: existing.claimTypeConfidence ?? existing.confidence ?? 0, status: existing.status, requiresProducerApproval: true }) as PipelineEvent);
      logResult('succeeded', { claimTypeTag: requestedTag });
      return { ok: true, claim: claimState.getClaim(claimId) };
    }

    if (action === 'generate-package') {
      const policy = withPolicy(existing);
      if (!policy.exportEligibility) { logResult(`failed_${policy.exportBlockReason ?? 'blocked'}`); return reply.status(409).send({ ok: false, error: policyBlockMessage(policy.exportBlockReason ?? 'blocked', policy) }); }
      const approvedVersion = Number.isInteger(policy.approvedVersion) ? policy.approvedVersion : null;
      if (!approvedVersion) { logResult('failed_missing_approved_version'); return reply.status(409).send({ ok: false, error: 'Claim approval is stale. Re-approve the latest researched claim before exporting.' }); }
      const generated = await outputPackageService.queueForClaim({ ...policy, version: approvedVersion! }, { runId: existing.runId });
      activityStore.enqueueOutputPackage(generated as unknown as Record<string, unknown>);
      logResult('succeeded', { packageId: generated.packageId });
      return { ok: true, claim: claimState.getClaim(claimId), package: generated };
    }

    if (action === 'render-image') {
      const policy = withPolicy(existing);
      if (!policy.exportEligibility) { logResult(`failed_${policy.exportBlockReason ?? 'blocked'}`); return reply.status(409).send({ ok: false, error: policyBlockMessage(policy.exportBlockReason ?? 'blocked', policy) }); }
      const approvedVersion = Number.isInteger(policy.approvedVersion) ? policy.approvedVersion : null;
      if (!approvedVersion) { logResult('failed_missing_approved_version'); return reply.status(409).send({ ok: false, error: 'Claim approval is stale. Re-approve the latest researched claim before rendering.' }); }
      const force = Boolean(body.force);
      const currentJob = renderService.getByClaimId(claimId);
      if (!force && currentJob && (currentJob.status === 'queued' || currentJob.status === 'rendering')) { logResult('noop_render_inflight', { renderJobId: currentJob.renderJobId }); return reply.status(202).send({ ok: true, claim: claimState.getClaim(claimId), renderJob: currentJob }); }
      let outputPackage = outputPackageService.getByClaimId(claimId);
      if (!outputPackage || outputPackage.status !== 'ready') { outputPackage = await outputPackageService.queueForClaim({ ...policy, version: approvedVersion! }, { runId: policy.runId }); activityStore.enqueueOutputPackage(outputPackage as unknown as Record<string, unknown>); }
      if (!outputPackage || outputPackage.status !== 'ready') { logResult('failed_package_generation'); return reply.status(502).send({ ok: false, error: outputPackage?.error ?? 'Package generation failed.' }); }
      const claimForRender = { ...policy, version: approvedVersion!, renderTemplateId: outputPackage?.templateVersion ?? 'fc-lower-third-v1', renderPayload: (outputPackage?.payload as unknown as Record<string, unknown>)?.fields as Record<string, unknown> ?? outputPackage?.payload as unknown as Record<string, unknown> ?? null };
      const renderJob = await renderService.queueRender(claimForRender, { runId: policy.runId, force, forceNonce: typeof body.forceNonce === 'string' && (body.forceNonce as string).trim() ? (body.forceNonce as string).trim().slice(0, 80) : undefined });
      logResult('succeeded', { renderJobId: renderJob.renderJobId, rendererMode: renderJob.rendererMode ?? null });
      return reply.status(202).send({ ok: true, claim: claimState.getClaim(claimId), package: outputPackage, renderJob });
    }

    if (action === 'approve-output') {
      if (existing.outputApprovalState === 'approved') { logResult('noop_already_approved'); return { ok: true, claim: existing, package: outputPackageService.getByClaimId(claimId), renderJob: renderService.getByClaimId(claimId) }; }
      const policy = withPolicy(existing);
      if (!policy.approvalEligibility) { logResult(`failed_${policy.approvalBlockReason ?? 'blocked'}`); return reply.status(409).send({ ok: false, error: policyBlockMessage(policy.approvalBlockReason ?? 'blocked', policy) }); }
      emitEvent(buildClaimEventPayload('claim.output_approved', policy, { outputApprovalState: 'approved', approvedAt: new Date().toISOString(), approvedVersion: nextClaimVersion(policy) }) as PipelineEvent);
      const updatedClaim = claimState.getClaim(claimId);
      const av = Number.isInteger(updatedClaim?.approvedVersion) ? updatedClaim!.approvedVersion : null;
      const generatedPackage = await outputPackageService.queueForClaim({ ...updatedClaim!, version: av ?? updatedClaim?.version ?? null }, { runId: existing.runId });
      activityStore.enqueueOutputPackage(generatedPackage as unknown as Record<string, unknown>);
      if (generatedPackage.status !== 'ready') { logResult('failed_package_generation', { packageId: generatedPackage.packageId }); return reply.status(502).send({ ok: false, claim: claimState.getClaim(claimId), package: generatedPackage, error: generatedPackage.error ?? 'Package generation failed' }); }
      const renderJob = await renderService.queueRender({ ...updatedClaim!, version: av ?? updatedClaim?.version ?? null, renderTemplateId: generatedPackage?.templateVersion ?? 'fc-lower-third-v1', renderPayload: (generatedPackage?.payload as unknown as Record<string, unknown>)?.fields as Record<string, unknown> ?? generatedPackage?.payload as unknown as Record<string, unknown> ?? null }, { runId: existing.runId });
      logResult('succeeded', { packageId: generatedPackage.packageId, renderJobId: renderJob.renderJobId });
      return { ok: true, claim: claimState.getClaim(claimId), package: generatedPackage, renderJob };
    }

    // reject-output
    if (existing.outputApprovalState === 'rejected') { logResult('noop_already_rejected'); return { ok: true, claim: existing }; }
    emitEvent(buildClaimEventPayload('claim.output_rejected', existing, { outputApprovalState: 'rejected', rejectedAt: new Date().toISOString() }) as PipelineEvent);
    logResult('succeeded');
    return { ok: true, claim: claimState.getClaim(claimId) };
  });

  // ── Static files ───────────────────────────────────────────────────────

  const rootDir = process.cwd();
  const controlDistDir = path.join(rootDir, 'dist', 'control');
  const publicDir = path.join(rootDir, 'public');
  const overlayDir = path.join(rootDir, 'client', 'overlay');
  const controlRoot = existsSync(controlDistDir) ? controlDistDir : publicDir;

  await app.register(fastifyStatic, {
    root: controlRoot,
    prefix: '/',
    decorateReply: true,
  });

  app.get('/overlay', async (request, reply) => {
    const query = request.query as Record<string, string>;
    const overlayKeyParam = typeof query.key === 'string' ? query.key.trim() : '';
    if (overlayKeyParam) {
      const entry = pipelineRegistry.getByOverlayKey(overlayKeyParam);
      if (!entry) {
        return reply.status(404).send({ ok: false, error: 'Invalid or expired overlay key.' });
      }
    }
    if (existsSync(path.join(overlayDir, 'index.html'))) {
      return reply.sendFile('index.html', overlayDir);
    }
    return reply.sendFile('overlay.html', publicDir);
  });

  app.get('/', async (_request, reply) => {
    if (controlRoot === controlDistDir) {
      return reply.sendFile('index.html', controlDistDir);
    }
    return reply.sendFile('control.html', publicDir);
  });
}
