import path from 'node:path';
import { timingSafeEqual, randomUUID } from 'node:crypto';

import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import fastifyRateLimit from '@fastify/rate-limit';

import { getEnv } from './env.js';
import { createActivityStore } from './activity-store.js';
import { evaluateClaimPolicy } from './policy-engine.js';
import { createOutputPackageService } from './output-package-service.js';
import { createRenderService } from './render-service.js';
import { createPipelineRegistry, type PipelineEntry } from './pipeline-registry.js';
import * as claimState from './claim-state.js';
import { createLogger } from './logger.js';
import type { Claim, PipelineEvent, PipelineInstance, PolicyEvaluation } from './types.js';

const env = getEnv();
const log = createLogger('server');

// ── Global state ───────────────────────────────────────────────────────────

// Pipeline registry manages multiple pipeline instances by ID.
// For backward compatibility, single-pipeline mode uses `defaultPipelineId` to
// track the "active" pipeline. The global claim-state, event history, and SSE
// broadcast serve the default pipeline.
const pipelineRegistry = createPipelineRegistry({
  takumiRenderUrl: env.TAKUMI_RENDER_URL,
  renderTimeoutMs: env.RENDER_TIMEOUT_MS,
});

let defaultPipelineId: string | null = null;
let currentRunId: string | null = null;
let currentOverlayKey: string | null = null;
let eventSeq = 0;
const eventHistory: PipelineEvent[] = [];
const sseClients = new Set<import('node:http').ServerResponse>();

const outputPackageService = createOutputPackageService();
const renderService = createRenderService({ takumiRenderUrl: env.TAKUMI_RENDER_URL, timeoutMs: env.RENDER_TIMEOUT_MS });
const activityStore = createActivityStore({ databaseUrl: env.DATABASE_URL, onError: (error) => { log.error({ err: error }, 'activity-store error'); } });

/** Get the active default pipeline instance, if any. */
function getActivePipeline(): PipelineInstance | null {
  if (!defaultPipelineId) return null;
  const entry = pipelineRegistry.get(defaultPipelineId);
  return entry?.pipeline ?? null;
}

claimState.startCleanupInterval();

// ── Helpers ────────────────────────────────────────────────────────────────

function safeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function isClaimEventType(type: string): boolean { return type.startsWith('claim.'); }

function parseExpectedVersion(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function nextClaimVersion(claim: Claim): number {
  const parsed = Number.parseInt(String(claim?.version ?? 1), 10);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed + 1 : 1;
}

function withPolicy(claim: Claim): Claim & PolicyEvaluation {
  return { ...claim, ...evaluateClaimPolicy(claim) };
}

function isValidClaimTypeTag(tag: string): boolean {
  return tag === 'numeric_factual' || tag === 'simple_policy' || tag === 'other';
}

function logClaimAction(payload: Record<string, unknown>): void {
  activityStore.enqueueAction({ at: new Date().toISOString(), ...payload });
}

function policyBlockMessage(reason: string, claim: Claim): string {
  switch (reason) {
    case 'still_researching': return 'Claim is still being researched. Approve after fact-check completes.';
    case 'not_researched': return 'Claim must reach researched status before approval.';
    case 'provider_degraded': return 'Evidence provider is degraded. Keep this claim unapproved until evidence recovers.';
    case 'insufficient_sources': return 'Claim does not have enough independent evidence sources for approval.';
    case 'conflicted_sources': return 'Evidence sources conflict. Manual adjudication is required before approval.';
    case 'below_threshold': return `Claim confidence is below policy threshold for tag=${claim.claimTypeTag ?? 'other'}.`;
    case 'rejected_locked': return 'Claim output was already rejected. Use a fresh claim update to re-approve.';
    case 'not_approved': return 'Claim must be approved before package/render actions.';
    default: return 'Action blocked by fail-closed policy.';
  }
}

function buildClaimEventPayload(type: string, claim: Claim, extras: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type, runId: claim.runId, claimId: claim.claimId, claim: claim.claim,
    status: claim.status, verdict: claim.verdict, confidence: claim.confidence,
    summary: claim.summary, sources: claim.sources, chunkStartSec: claim.chunkStartSec,
    chunkStartClock: claim.chunkStartClock, claimCategory: claim.claimCategory,
    claimTypeTag: claim.claimTypeTag, claimTypeConfidence: claim.claimTypeConfidence,
    googleEvidenceState: claim.googleEvidenceState, fredEvidenceState: claim.fredEvidenceState,
    fredEvidenceSummary: claim.fredEvidenceSummary, fredEvidenceSources: claim.fredEvidenceSources,
    congressEvidenceState: claim.congressEvidenceState, congressEvidenceSummary: claim.congressEvidenceSummary,
    congressEvidenceSources: claim.congressEvidenceSources, ...extras,
  };
}

function claimSnapshotEventFields(claim: Claim): Record<string, unknown> {
  return {
    claim: claim.claim, status: claim.status, verdict: claim.verdict, confidence: claim.confidence,
    summary: claim.summary, sources: claim.sources, chunkStartSec: claim.chunkStartSec,
    chunkStartClock: claim.chunkStartClock, claimCategory: claim.claimCategory,
    claimTypeTag: claim.claimTypeTag, claimTypeConfidence: claim.claimTypeConfidence,
    googleEvidenceState: claim.googleEvidenceState, fredEvidenceState: claim.fredEvidenceState,
    fredEvidenceSummary: claim.fredEvidenceSummary, fredEvidenceSources: claim.fredEvidenceSources,
    congressEvidenceState: claim.congressEvidenceState, congressEvidenceSummary: claim.congressEvidenceSummary,
    congressEvidenceSources: claim.congressEvidenceSources,
    correctedClaim: claim.correctedClaim, aiSummary: claim.aiSummary, aiVerdict: claim.aiVerdict,
    aiConfidence: claim.aiConfidence, evidenceBasis: claim.evidenceBasis,
    googleFcVerdict: claim.googleFcVerdict, googleFcConfidence: claim.googleFcConfidence,
    googleFcSummary: claim.googleFcSummary, outputApprovalState: claim.outputApprovalState,
    outputPackageStatus: claim.outputPackageStatus, outputPackageId: claim.outputPackageId,
    outputPackageError: claim.outputPackageError, renderStatus: claim.renderStatus,
    renderJobId: claim.renderJobId, artifactUrl: claim.artifactUrl, renderError: claim.renderError,
    policyThreshold: claim.policyThreshold, independentSourceCount: claim.independentSourceCount,
    evidenceConflict: claim.evidenceConflict, evidenceStatus: claim.evidenceStatus,
    approvalEligibility: claim.approvalEligibility, approvalBlockReason: claim.approvalBlockReason,
    exportEligibility: claim.exportEligibility, exportBlockReason: claim.exportBlockReason,
    approvedVersion: claim.approvedVersion ?? null, version: claim.version, updatedAt: claim.updatedAt,
  };
}

function isValidYoutubeUrl(value: string): boolean {
  try { const parsed = new URL(value); return ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(parsed.hostname.toLowerCase()); } catch { return false; }
}

// ── Claim state management ─────────────────────────────────────────────────

function updateClaimState(event: PipelineEvent): void {
  const e = event as Record<string, unknown>;
  if (currentRunId && isClaimEventType(e.type as string) && e.runId && e.runId !== currentRunId) return;

  if (e.type === 'claim.detected') {
    const row = withPolicy({
      claimId: e.claimId as string, runId: e.runId as string ?? null, claim: e.claim as string,
      status: e.status as string, verdict: (e.verdict ?? 'unverified') as Claim['verdict'],
      confidence: e.confidence as number, reasons: e.reasons as string[],
      claimCategory: (e.claimCategory ?? 'general') as Claim['claimCategory'],
      claimTypeTag: (e.claimTypeTag ?? 'other') as Claim['claimTypeTag'],
      claimTypeConfidence: (e.claimTypeConfidence ?? e.confidence ?? 0) as number,
      googleEvidenceState: 'none', fredEvidenceState: e.claimCategory === 'economic' ? 'ambiguous' : 'not_applicable',
      fredEvidenceSummary: e.claimCategory === 'economic' ? 'Awaiting economic evidence enrichment.' : 'No economic indicator mapping required for this claim.',
      fredEvidenceSources: [], congressEvidenceState: (e.claimCategory === 'political' || e.claimCategory === 'legislative') ? 'ambiguous' : 'not_applicable',
      congressEvidenceSummary: (e.claimCategory === 'political' || e.claimCategory === 'legislative') ? 'Awaiting legislative evidence enrichment.' : 'No legislative evidence lookup required for this claim.',
      congressEvidenceSources: [], correctedClaim: null, aiSummary: null, aiVerdict: null, aiConfidence: null, evidenceBasis: null,
      googleFcVerdict: null, googleFcConfidence: null, googleFcSummary: null,
      chunkStartSec: e.chunkStartSec as number, chunkStartClock: e.chunkStartClock as string,
      sources: [], summary: null, outputApprovalState: 'pending', outputPackageStatus: 'none',
      outputPackageId: null, outputPackageError: null, renderStatus: 'none', renderJobId: null,
      artifactUrl: null, renderError: null, approvedAt: null, approvedVersion: null, rejectedAt: null,
      detectedAt: e.at as string, updatedAt: e.at as string, version: 1,
    } as Claim);
    claimState.setClaim(e.claimId as string, row);
    return;
  }

  if (e.type === 'claim.researching') {
    const existing = claimState.getClaim(e.claimId as string);
    if (existing) claimState.setClaim(e.claimId as string, withPolicy({ ...existing, status: 'researching', updatedAt: e.at as string, version: (existing.version ?? 1) + 1 }));
    return;
  }

  if (e.type === 'claim.updated') {
    const existing = claimState.getClaim(e.claimId as string) ?? { claimId: e.claimId, claim: e.claim, detectedAt: e.at } as Claim;
    const wasApproved = existing.outputApprovalState === 'approved';
    const nextApprovalState = wasApproved ? 'pending' : existing.outputApprovalState ?? 'pending';
    const reset = wasApproved;
    claimState.setClaim(e.claimId as string, withPolicy({
      ...existing, runId: (e.runId as string) ?? existing.runId ?? currentRunId ?? null,
      status: e.status as string, verdict: e.verdict as Claim['verdict'], confidence: e.confidence as number,
      summary: e.summary as string, sources: e.sources as Claim['sources'],
      requiresProducerApproval: e.requiresProducerApproval as boolean,
      claimCategory: (e.claimCategory ?? existing.claimCategory ?? 'general') as Claim['claimCategory'],
      claimTypeTag: (e.claimTypeTag ?? existing.claimTypeTag ?? 'other') as Claim['claimTypeTag'],
      claimTypeConfidence: (e.claimTypeConfidence ?? existing.claimTypeConfidence ?? e.confidence ?? 0) as number,
      googleEvidenceState: (e.googleEvidenceState ?? existing.googleEvidenceState ?? 'none') as Claim['googleEvidenceState'],
      fredEvidenceState: (e.fredEvidenceState ?? existing.fredEvidenceState ?? 'not_applicable') as Claim['fredEvidenceState'],
      fredEvidenceSummary: (e.fredEvidenceSummary ?? existing.fredEvidenceSummary ?? null) as string | null,
      fredEvidenceSources: (e.fredEvidenceSources ?? existing.fredEvidenceSources ?? []) as Claim['fredEvidenceSources'],
      congressEvidenceState: (e.congressEvidenceState ?? existing.congressEvidenceState ?? 'not_applicable') as Claim['congressEvidenceState'],
      congressEvidenceSummary: (e.congressEvidenceSummary ?? existing.congressEvidenceSummary ?? null) as string | null,
      congressEvidenceSources: (e.congressEvidenceSources ?? existing.congressEvidenceSources ?? []) as Claim['congressEvidenceSources'],
      correctedClaim: (e.correctedClaim ?? existing.correctedClaim ?? null) as string | null,
      aiSummary: (e.aiSummary ?? existing.aiSummary ?? null) as string | null,
      aiVerdict: (e.aiVerdict ?? existing.aiVerdict ?? null) as Claim['aiVerdict'],
      aiConfidence: (e.aiConfidence ?? existing.aiConfidence ?? null) as number | null,
      evidenceBasis: (e.evidenceBasis ?? existing.evidenceBasis ?? null) as Claim['evidenceBasis'],
      googleFcVerdict: (e.googleFcVerdict ?? existing.googleFcVerdict ?? null) as Claim['googleFcVerdict'],
      googleFcConfidence: (e.googleFcConfidence ?? existing.googleFcConfidence ?? null) as number | null,
      googleFcSummary: (e.googleFcSummary ?? existing.googleFcSummary ?? null) as string | null,
      outputApprovalState: nextApprovalState as Claim['outputApprovalState'],
      approvedAt: reset ? null : existing.approvedAt ?? null,
      approvedVersion: reset ? null : existing.approvedVersion ?? null,
      outputPackageStatus: reset ? 'none' : existing.outputPackageStatus ?? 'none',
      outputPackageId: reset ? null : existing.outputPackageId ?? null,
      outputPackageError: reset ? null : existing.outputPackageError ?? null,
      renderStatus: reset ? 'none' : existing.renderStatus ?? 'none',
      renderJobId: reset ? null : existing.renderJobId ?? null,
      artifactUrl: reset ? null : existing.artifactUrl ?? null,
      renderError: reset ? null : existing.renderError ?? null,
      updatedAt: e.at as string, version: (existing.version ?? 1) + 1,
    } as Claim));
    return;
  }

  const claimId = e.claimId as string;
  if (!claimId) return;
  const existing = claimState.getClaim(claimId);
  if (!existing) return;

  if (e.type === 'claim.output_approved') {
    claimState.setClaim(claimId, withPolicy({ ...existing, outputApprovalState: 'approved', approvedAt: (e.approvedAt ?? e.at) as string, approvedVersion: (e.approvedVersion ?? nextClaimVersion(existing)) as number, rejectedAt: null, updatedAt: e.at as string, version: (existing.version ?? 1) + 1 }));
  } else if (e.type === 'claim.output_rejected') {
    claimState.setClaim(claimId, withPolicy({ ...existing, outputApprovalState: 'rejected', approvedAt: null, approvedVersion: null, rejectedAt: (e.rejectedAt ?? e.at) as string, updatedAt: e.at as string, version: (existing.version ?? 1) + 1 }));
  } else if (e.type === 'claim.output_package_queued' || e.type === 'claim.output_package_ready' || e.type === 'claim.output_package_failed') {
    if (existing.outputApprovalState !== 'approved') return;
    if (Number.isInteger(e.claimVersion) && Number.isInteger(existing.approvedVersion) && e.claimVersion !== existing.approvedVersion) return;
    const status = e.type === 'claim.output_package_queued' ? 'queued' : e.type === 'claim.output_package_ready' ? 'ready' : 'failed';
    claimState.setClaim(claimId, withPolicy({ ...existing, outputPackageStatus: status as Claim['outputPackageStatus'], outputPackageId: (e.packageId ?? existing.outputPackageId ?? null) as string | null, outputPackageError: status === 'failed' ? ((e.error ?? 'Package generation failed') as string) : null, updatedAt: e.at as string, version: (existing.version ?? 1) + 1 }));
  } else if (e.type === 'claim.render_queued' || e.type === 'claim.render_ready' || e.type === 'claim.render_failed') {
    if (existing.outputApprovalState !== 'approved') return;
    if (Number.isInteger(e.claimVersion) && Number.isInteger(existing.approvedVersion) && e.claimVersion !== existing.approvedVersion) return;
    if ((e.type === 'claim.render_ready' || e.type === 'claim.render_failed') && existing.renderJobId && e.renderJobId && existing.renderJobId !== e.renderJobId) return;
    const status = e.type === 'claim.render_queued' ? 'queued' : e.type === 'claim.render_ready' ? 'ready' : 'failed';
    claimState.setClaim(claimId, withPolicy({
      ...existing, renderStatus: status as Claim['renderStatus'],
      renderJobId: (e.renderJobId ?? existing.renderJobId ?? null) as string | null,
      artifactUrl: status === 'ready' ? ((e.artifactUrl ?? existing.artifactUrl ?? null) as string | null) : existing.artifactUrl,
      renderError: status === 'failed' ? ((e.error ?? 'Render job failed') as string) : null,
      updatedAt: e.at as string, version: (existing.version ?? 1) + 1,
    }));
  }
}

// ── Event emission / SSE broadcast ─────────────────────────────────────────

function emitEvent(event: PipelineEvent): void {
  let enriched: PipelineEvent = { seq: ++eventSeq, ...event };
  const e = enriched as Record<string, unknown>;

  if (e.type === 'pipeline.started') { currentRunId = (e.runId as string) ?? null; eventHistory.length = 0; }
  updateClaimState(enriched);

  if (e.type === 'pipeline.started') {
    activityStore.enqueueRunStart({ runId: e.runId ?? null, youtubeUrl: e.youtubeUrl ?? null, chunkSeconds: e.chunkSeconds ?? null, model: e.model ?? null, startedAt: e.at });
  } else if (e.type === 'pipeline.stopped') {
    activityStore.enqueueRunStop({ runId: e.runId ?? currentRunId ?? null, reason: e.reason ?? null, stoppedAt: e.at });
  }

  if (isClaimEventType(e.type as string) && e.claimId) {
    const snapshot = claimState.getClaim(e.claimId as string);
    if (snapshot) { enriched = { ...enriched, ...claimSnapshotEventFields(snapshot) }; activityStore.enqueueClaimSnapshot(snapshot as unknown as Record<string, unknown>); }
  }

  eventHistory.push(enriched);
  if (eventHistory.length > 1000) eventHistory.shift();
  activityStore.enqueueEvent(enriched);

  if (e.type === 'pipeline.stopped' && (!e.runId || e.runId === currentRunId)) {
    if (defaultPipelineId) {
      pipelineRegistry.remove(defaultPipelineId);
    }
    defaultPipelineId = null;
    currentRunId = null;
    currentOverlayKey = null;
  }

  const data = `id: ${(enriched as Record<string, unknown>).seq}\nevent: ${(enriched as Record<string, unknown>).type}\ndata: ${JSON.stringify(enriched)}\n\n`;
  for (const client of sseClients) {
    try { if (!client.destroyed) client.write(data); } catch { sseClients.delete(client); }
  }
}

outputPackageService.setEventHandler(emitEvent);
renderService.setEventHandler(emitEvent);
renderService.setJobUpdateHandler((job) => { activityStore.enqueueRenderJob(job as unknown as Record<string, unknown>); });

// ── Auth hook ──────────────────────────────────────────────────────────────

function isControlAction(url: string, method: string): boolean {
  if (method !== 'POST') return false;
  if (url === '/api/start' || url === '/api/stop') return true;
  if (/^\/api\/claims\/[^/]+\/(approve-output|reject-output|generate-package|render-image|tag-override)$/.test(url)) return true;
  return false;
}

function isReadProtected(url: string, method: string): boolean {
  if (method !== 'GET' || !env.PROTECT_READ_ENDPOINTS) return false;
  if (url === '/api/claims' || url === '/api/output-packages' || url === '/events') return true;
  if (/^\/api\/claims\/[^/]+\/(output-package|render-job)$/.test(url)) return true;
  return false;
}

// ── Fastify setup ──────────────────────────────────────────────────────────

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    ...(process.env.NODE_ENV !== 'production' && {
      transport: { target: 'pino-pretty', options: { colorize: true } },
    }),
  },
  bodyLimit: 1_000_000,
});

await app.register(fastifyCors, { origin: true });

await app.register(fastifyRateLimit, {
  max: env.CONTROL_RATE_LIMIT_PER_MIN,
  timeWindow: '1 minute',
  keyGenerator: (request) => {
    const xff = request.headers['x-forwarded-for'];
    const ip = typeof xff === 'string' ? xff.split(',')[0].trim() : request.ip;
    return `${ip}:${request.url}`;
  },
  allowList: (request) => {
    const url = request.url?.split('?')[0] ?? '';
    return !isControlAction(url, request.method) && !isReadProtected(url, request.method);
  },
});

// Auth preHandler
app.addHook('preHandler', async (request, reply) => {
  const url = request.url.split('?')[0];
  const needsAuth = isControlAction(url, request.method) || isReadProtected(url, request.method);
  if (!needsAuth || !env.CONTROL_PASSWORD) return;

  const headerValue = request.headers['x-control-password'];
  const provided = typeof headerValue === 'string' && headerValue.trim() ? headerValue.trim() : '';
  if (!provided) {
    const queryValue = (request.query as Record<string, string>)?.control_password;
    if (typeof queryValue === 'string' && queryValue.trim() && safeEquals(queryValue.trim(), env.CONTROL_PASSWORD)) return;
    return reply.status(401).send({ ok: false, error: 'Unauthorized. Provide x-control-password header or ?control_password= query.' });
  }
  if (!safeEquals(provided, env.CONTROL_PASSWORD)) {
    return reply.status(401).send({ ok: false, error: 'Unauthorized. Provide x-control-password header or ?control_password= query.' });
  }
});

// ── Routes ─────────────────────────────────────────────────────────────────

app.get('/health', async () => {
  const activePipeline = getActivePipeline();
  const dbStatus = activityStore.getStatus();
  const pipelineStatus = activePipeline?.getStatus() ?? null;
  return {
    ok: true, running: Boolean(activePipeline?.isRunning()), runId: currentRunId, overlayKey: currentOverlayKey,
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

app.get('/api/claims', async () => ({
  ok: true, running: Boolean(getActivePipeline()?.isRunning()), runId: currentRunId, claims: claimState.getClaimsSorted(),
}));

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

// Export rendered PNG for a claim
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
  // External URL — redirect
  return reply.redirect(url);
});

// SSE endpoint — uses raw response for streaming
app.get('/events', async (request, reply) => {
  const raw = reply.raw;
  reply.hijack();
  raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
  });
  raw.write('retry: 2000\n\n');

  const lastEventIdRaw = request.headers['last-event-id'];
  const lastEventId = typeof lastEventIdRaw === 'string' ? Number.parseInt(lastEventIdRaw, 10) : Number.NaN;
  const replayEvents = Number.isInteger(lastEventId)
    ? eventHistory.filter((ev) => ((ev as Record<string, unknown>).seq as number) > lastEventId).slice(-200)
    : eventHistory.slice(-25);

  sseClients.add(raw);
  raw.on('error', () => { sseClients.delete(raw); });

  for (const ev of replayEvents) {
    const e = ev as Record<string, unknown>;
    raw.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(ev)}\n\n`);
  }

  const heartbeat = setInterval(() => {
    try { if (!raw.destroyed) raw.write(': heartbeat\n\n'); else { clearInterval(heartbeat); sseClients.delete(raw); } }
    catch { clearInterval(heartbeat); sseClients.delete(raw); }
  }, 15000);

  request.raw.on('close', () => { clearInterval(heartbeat); sseClients.delete(raw); });
});

// Pipeline start/stop
app.post('/api/start', async (request, reply) => {
  const body = request.body as Record<string, unknown>;
  const youtubeUrl = String(body.youtubeUrl ?? '').trim();
  const speechContext = String(body.speechContext ?? env.SPEECH_CONTEXT).trim();
  const operatorNotes = String(body.operatorNotes ?? env.OPERATOR_NOTES).trim();

  if (!isValidYoutubeUrl(youtubeUrl)) {
    const hint = isValidYoutubeUrl(speechContext) ? ' It looks like the YouTube URL was entered in the speech context field.' : '';
    return reply.status(400).send({ ok: false, error: 'A valid YouTube URL is required.' + hint });
  }
  if (getActivePipeline()?.isRunning()) {
    return reply.status(409).send({ ok: false, error: 'Pipeline is already running. Stop it before starting a new stream.' });
  }

  // Clear previous pipeline state
  claimState.clearClaims(); outputPackageService.clear(); renderService.clear(); eventHistory.length = 0; currentRunId = null; currentOverlayKey = null;
  if (defaultPipelineId) { pipelineRegistry.remove(defaultPipelineId); defaultPipelineId = null; }

  const pipelineConfig = {
    youtubeUrl, geminiApiKey: env.GEMINI_API_KEY, geminiModel: env.GEMINI_TRANSCRIBE_MODEL,
    factCheckApiKey: env.GOOGLE_FACT_CHECK_API_KEY, fredApiKey: env.FRED_API_KEY,
    congressApiKey: env.CONGRESS_API_KEY, chunkSeconds: env.CHUNK_SECONDS,
    maxResearchConcurrency: env.MAX_RESEARCH_CONCURRENCY, claimDetectionThreshold: env.CLAIM_DETECTION_THRESHOLD,
    ingestReconnectEnabled: env.INGEST_RECONNECT_ENABLED, ingestMaxRetries: env.INGEST_MAX_RETRIES,
    ingestRetryBaseMs: env.INGEST_RETRY_BASE_MS, ingestRetryMaxMs: env.INGEST_RETRY_MAX_MS,
    ingestStallTimeoutMs: env.INGEST_STALL_TIMEOUT_MS, ingestVerboseLogs: env.INGEST_VERBOSE_LOGS,
    geminiVerifyModel: env.GEMINI_VERIFY_MODEL, speechContext, operatorNotes, onEvent: emitEvent,
  };

  let entry: PipelineEntry;
  try {
    // Use the pipeline's own runId as the registry key (single-pipeline mode)
    // We need to create the pipeline first to get its runId, so we pass config to registry
    entry = pipelineRegistry.start(randomUUID(), pipelineConfig);
  } catch (error) {
    return reply.status(500).send({ ok: false, error: (error as Error).message });
  }

  defaultPipelineId = entry.pipelineId;
  currentOverlayKey = entry.overlayKey;

  // Wire up per-pipeline output package and render services to the shared event emitter
  entry.outputPackageService.setEventHandler(emitEvent);
  entry.renderService.setEventHandler(emitEvent);
  entry.renderService.setJobUpdateHandler((job) => { activityStore.enqueueRenderJob(job as unknown as Record<string, unknown>); });

  return reply.status(202).send({ ok: true, runId: entry.runId, overlayKey: entry.overlayKey });
});

app.post('/api/stop', async () => {
  const activePipeline = getActivePipeline();
  if (activePipeline?.isRunning()) {
    try { activePipeline.stop('user_requested_stop'); } catch (error) { log.error({ err: error }, 'pipeline.stop() error'); }
  }
  return { ok: true, running: Boolean(getActivePipeline()?.isRunning()) };
});

// Pipeline registry listing (multi-pipeline support)
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

// Claim actions
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
  const logResult = (result: string, extra: Record<string, unknown> = {}) => { logClaimAction({ runId: existing?.runId ?? currentRunId ?? null, claimId, action, actorId, reason, expectedVersion, result, ...extra }); };

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

// Static files
const rootDir = process.cwd();
const controlDistDir = path.join(rootDir, 'dist', 'control');
const publicDir = path.join(rootDir, 'public');
const overlayDir = path.join(rootDir, 'client', 'overlay');

// Serve built Vue SPA (production) or fallback to public/ (dev/legacy)
import { existsSync } from 'node:fs';
const controlRoot = existsSync(controlDistDir) ? controlDistDir : publicDir;

await app.register(fastifyStatic, {
  root: controlRoot,
  prefix: '/',
  decorateReply: false,
});

// Overlay served from client/overlay/ or public/
// Supports ?key={overlayKey} to validate that the overlay key matches an active pipeline.
// Without a key, the overlay serves normally (backward compatible).
app.get('/overlay', async (request, reply) => {
  const query = request.query as Record<string, string>;
  const overlayKeyParam = typeof query.key === 'string' ? query.key.trim() : '';

  // If an overlay key is provided, validate it matches an active pipeline
  if (overlayKeyParam) {
    const entry = pipelineRegistry.getByOverlayKey(overlayKeyParam);
    if (!entry) {
      return reply.status(404).send({ ok: false, error: 'Invalid or expired overlay key.' });
    }
    // Overlay key is valid; serve the overlay page
  }

  if (existsSync(path.join(overlayDir, 'index.html'))) {
    return reply.sendFile('index.html', overlayDir);
  }
  return reply.sendFile('overlay.html', publicDir);
});

// SPA fallback: serve index.html for unmatched routes (Vue Router history mode)
app.get('/', async (_request, reply) => {
  if (controlRoot === controlDistDir) {
    return reply.sendFile('index.html', controlDistDir);
  }
  return reply.sendFile('control.html', publicDir);
});

// ── Hydration + Bootstrap ──────────────────────────────────────────────────

async function hydrateStateFromStore(): Promise<void> {
  await activityStore.init();
  const storedClaims = await activityStore.loadLatestRunClaims(1000);
  if (!Array.isArray(storedClaims) || storedClaims.length === 0) return;
  claimState.clearClaims(); currentRunId = null;
  for (const claim of storedClaims) {
    if (!claim || typeof claim !== 'object' || !('claimId' in claim)) continue;
    const c = claim as Record<string, unknown>;
    const normalized = withPolicy({
      ...c, outputApprovalState: c.outputApprovalState ?? 'pending', outputPackageStatus: c.outputPackageStatus ?? 'none',
      renderStatus: c.renderStatus ?? 'none', version: Number.isInteger(c.version) ? c.version : 1,
    } as Claim);
    claimState.setClaim(normalized.claimId, normalized);
    if (!currentRunId && normalized.runId) currentRunId = normalized.runId;
  }
}

async function bootstrap(): Promise<void> {
  try { await hydrateStateFromStore(); } catch (error) { log.error({ err: error }, 'startup hydration failed'); }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutting down');
    pipelineRegistry.stopAll('shutdown');
    claimState.stopCleanupInterval();
    try { await app.close(); } catch { /* noop */ }
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => { log.error({ reason }, 'unhandled rejection'); });
  process.on('uncaughtException', (error) => { log.error({ err: error }, 'uncaught exception'); });

  await app.listen({ port: env.PORT, host: env.HOST });
}

void bootstrap();
