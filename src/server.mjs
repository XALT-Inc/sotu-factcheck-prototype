import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';

import { loadEnv } from './env.mjs';
import { createActivityStore } from './activityStore.mjs';
import { evaluateClaimPolicy } from './policyEngine.mjs';
import { createPipeline } from './pipeline.mjs';
import { createOutputPackageService } from './outputPackageService.mjs';
import { createRenderService } from './renderService.mjs';

loadEnv();

function parseNonNegativeInt(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return fallback;
  }

  return Math.min(parsed, max);
}

function parsePositiveInt(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(parsed, max);
}

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';
const CHUNK_SECONDS = Number(process.env.CHUNK_SECONDS ?? 15);
const CONTROL_PASSWORD = String(process.env.CONTROL_PASSWORD ?? '').trim();
const FRED_API_KEY = String(process.env.FRED_API_KEY ?? '').trim();
const DATABASE_URL = String(process.env.DATABASE_URL ?? '').trim();
const TAKUMI_RENDER_URL = String(process.env.TAKUMI_RENDER_URL ?? '').trim();
const RENDER_TIMEOUT_MS = Number(process.env.RENDER_TIMEOUT_MS ?? 5000);
const MAX_RESEARCH_CONCURRENCY = Number(process.env.MAX_RESEARCH_CONCURRENCY ?? 3);
const CLAIM_DETECTION_THRESHOLD = Math.max(
  0.55,
  Math.min(0.9, Number(process.env.CLAIM_DETECTION_THRESHOLD ?? 0.62))
);
const PROTECT_READ_ENDPOINTS = String(
  process.env.PROTECT_READ_ENDPOINTS ?? (process.env.NODE_ENV === 'production' ? 'true' : 'false')
)
  .trim()
  .toLowerCase() === 'true';
const CONTROL_RATE_LIMIT_PER_MIN = Math.max(
  30,
  Math.min(2000, Number(process.env.CONTROL_RATE_LIMIT_PER_MIN ?? 120))
);
const INGEST_RECONNECT_ENABLED = String(process.env.INGEST_RECONNECT_ENABLED ?? 'true')
  .trim()
  .toLowerCase() !== 'false';
const INGEST_MAX_RETRIES = parseNonNegativeInt(process.env.INGEST_MAX_RETRIES ?? 0, 0, 10000);
const INGEST_RETRY_BASE_MS = parsePositiveInt(process.env.INGEST_RETRY_BASE_MS ?? 1000, 1000, 120000);
const INGEST_RETRY_MAX_MS = parsePositiveInt(process.env.INGEST_RETRY_MAX_MS ?? 15000, 15000, 600000);
const INGEST_STALL_TIMEOUT_MS = parsePositiveInt(
  process.env.INGEST_STALL_TIMEOUT_MS ?? 45000,
  45000,
  300000
);
const INGEST_VERBOSE_LOGS = String(process.env.INGEST_VERBOSE_LOGS ?? 'false')
  .trim()
  .toLowerCase() === 'true';

const rootDir = process.cwd();
const publicDir = path.join(rootDir, 'public');

let activePipeline = null;
let currentRunId = null;
let eventSeq = 0;
const eventHistory = [];
const claims = new Map();
const sseClients = new Set();
const controlRateWindows = new Map();
const outputPackageService = createOutputPackageService();
const renderService = createRenderService({
  takumiRenderUrl: TAKUMI_RENDER_URL,
  timeoutMs: RENDER_TIMEOUT_MS
});
const activityStore = createActivityStore({
  databaseUrl: DATABASE_URL,
  onError: (error) => {
    // eslint-disable-next-line no-console
    console.error(`[activity-store] ${error.message}`);
  }
});

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8'
  });
  response.end(JSON.stringify(payload));
}

function safeEquals(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

function requiresControlAuth(pathname, method) {
  if (method !== 'POST') {
    return false;
  }

  if (
    pathname === '/start' ||
    pathname === '/stop' ||
    pathname.match(/^\/claims\/([^/]+)\/(approve-output|reject-output|generate-package|render-image|tag-override)$/)
  ) {
    return true;
  }

  return false;
}

function requiresReadAuth(pathname, method) {
  if (method !== 'GET' || !PROTECT_READ_ENDPOINTS) {
    return false;
  }

  if (pathname === '/claims' || pathname === '/output-packages' || pathname === '/events') {
    return true;
  }

  if (pathname.match(/^\/claims\/([^/]+)\/(output-package|render-job)$/)) {
    return true;
  }

  return false;
}

function providedControlPassword(request, reqUrl) {
  const headerValue = request.headers['x-control-password'];
  if (typeof headerValue === 'string' && headerValue.trim()) {
    return headerValue.trim();
  }

  const queryValue = reqUrl.searchParams.get('control_password');
  if (typeof queryValue === 'string' && queryValue.trim()) {
    return queryValue.trim();
  }

  return '';
}

function isAuthorizedRequest(request, reqUrl) {
  if (!CONTROL_PASSWORD) {
    return true;
  }

  const provided = providedControlPassword(request, reqUrl);
  if (!provided) {
    return false;
  }

  return safeEquals(provided, CONTROL_PASSWORD);
}

function cleanupRateWindows(nowMs) {
  for (const [key, value] of controlRateWindows) {
    if (nowMs - value.windowStartMs > 60_000) {
      controlRateWindows.delete(key);
    }
  }
}

function rateLimitKey(request, pathname) {
  const ip =
    String(request.headers['x-forwarded-for'] ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)[0] ||
    request.socket.remoteAddress ||
    'unknown-ip';
  return `${ip}:${pathname}`;
}

function enforceControlRateLimit(request, pathname) {
  const nowMs = Date.now();
  cleanupRateWindows(nowMs);
  const key = rateLimitKey(request, pathname);
  const existing = controlRateWindows.get(key);
  if (!existing || nowMs - existing.windowStartMs >= 60_000) {
    controlRateWindows.set(key, {
      windowStartMs: nowMs,
      count: 1
    });
    return {
      ok: true,
      retryAfterSec: 0
    };
  }

  existing.count += 1;
  if (existing.count <= CONTROL_RATE_LIMIT_PER_MIN) {
    return {
      ok: true,
      retryAfterSec: 0
    };
  }

  const retryAfterSec = Math.max(1, Math.ceil((existing.windowStartMs + 60_000 - nowMs) / 1000));
  return {
    ok: false,
    retryAfterSec
  };
}

function isClaimEventType(type) {
  return type.startsWith('claim.');
}

function parseExpectedVersion(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function nextClaimVersion(claim) {
  const parsed = Number.parseInt(String(claim?.version ?? 1), 10);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed + 1 : 1;
}

function actorIdFromRequest(request) {
  const raw = request.headers['x-operator-id'];
  if (typeof raw !== 'string' || !raw.trim()) {
    return 'operator-unknown';
  }

  return raw.trim().slice(0, 120);
}

function buildClaimEventPayload(type, claim, extras = {}) {
  return {
    type,
    runId: claim.runId,
    claimId: claim.claimId,
    claim: claim.claim,
    status: claim.status,
    verdict: claim.verdict,
    confidence: claim.confidence,
    summary: claim.summary,
    sources: claim.sources,
    chunkStartSec: claim.chunkStartSec,
    chunkStartClock: claim.chunkStartClock,
    claimCategory: claim.claimCategory,
    claimTypeTag: claim.claimTypeTag,
    claimTypeConfidence: claim.claimTypeConfidence,
    googleEvidenceState: claim.googleEvidenceState,
    fredEvidenceState: claim.fredEvidenceState,
    fredEvidenceSummary: claim.fredEvidenceSummary,
    fredEvidenceSources: claim.fredEvidenceSources,
    ...extras
  };
}

function policyBlockMessage(reason, claim) {
  switch (reason) {
    case 'still_researching':
      return 'Claim is still being researched. Approve after fact-check completes.';
    case 'not_researched':
      return 'Claim must reach researched status before approval.';
    case 'provider_degraded':
      return 'Evidence provider is degraded. Keep this claim unapproved until evidence recovers.';
    case 'insufficient_sources':
      return 'Claim does not have enough independent evidence sources for approval.';
    case 'conflicted_sources':
      return 'Evidence sources conflict. Manual adjudication is required before approval.';
    case 'below_threshold':
      return `Claim confidence is below policy threshold for tag=${claim.claimTypeTag ?? 'other'}.`;
    case 'rejected_locked':
      return 'Claim output was already rejected. Use a fresh claim update to re-approve.';
    case 'not_approved':
      return 'Claim must be approved before package/render actions.';
    default:
      return 'Action blocked by fail-closed policy.';
  }
}

function isValidClaimTypeTag(tag) {
  return tag === 'numeric_factual' || tag === 'simple_policy' || tag === 'other';
}

function logClaimAction(payload) {
  activityStore.enqueueAction({
    at: new Date().toISOString(),
    ...payload
  });
}

function withPolicy(claim) {
  return {
    ...claim,
    ...evaluateClaimPolicy(claim)
  };
}

function claimSnapshotEventFields(claim) {
  return {
    claim: claim.claim,
    status: claim.status,
    verdict: claim.verdict,
    confidence: claim.confidence,
    summary: claim.summary,
    sources: claim.sources,
    chunkStartSec: claim.chunkStartSec,
    chunkStartClock: claim.chunkStartClock,
    claimCategory: claim.claimCategory,
    claimTypeTag: claim.claimTypeTag,
    claimTypeConfidence: claim.claimTypeConfidence,
    googleEvidenceState: claim.googleEvidenceState,
    fredEvidenceState: claim.fredEvidenceState,
    fredEvidenceSummary: claim.fredEvidenceSummary,
    fredEvidenceSources: claim.fredEvidenceSources,
    correctedClaim: claim.correctedClaim,
    aiSummary: claim.aiSummary,
    aiVerdict: claim.aiVerdict,
    aiConfidence: claim.aiConfidence,
    evidenceBasis: claim.evidenceBasis,
    googleFcVerdict: claim.googleFcVerdict,
    googleFcConfidence: claim.googleFcConfidence,
    googleFcSummary: claim.googleFcSummary,
    outputApprovalState: claim.outputApprovalState,
    outputPackageStatus: claim.outputPackageStatus,
    outputPackageId: claim.outputPackageId,
    outputPackageError: claim.outputPackageError,
    renderStatus: claim.renderStatus,
    renderJobId: claim.renderJobId,
    artifactUrl: claim.artifactUrl,
    renderError: claim.renderError,
    policyThreshold: claim.policyThreshold,
    independentSourceCount: claim.independentSourceCount,
    evidenceConflict: claim.evidenceConflict,
    evidenceStatus: claim.evidenceStatus,
    approvalEligibility: claim.approvalEligibility,
    approvalBlockReason: claim.approvalBlockReason,
    exportEligibility: claim.exportEligibility,
    exportBlockReason: claim.exportBlockReason,
    approvedVersion: claim.approvedVersion ?? null,
    version: claim.version,
    updatedAt: claim.updatedAt
  };
}

function updateClaimState(event) {
  if (
    currentRunId &&
    isClaimEventType(event.type) &&
    event.runId &&
    event.runId !== currentRunId
  ) {
    return;
  }

  if (event.type === 'claim.detected') {
    const row = withPolicy({
      claimId: event.claimId,
      runId: event.runId,
      claim: event.claim,
      status: event.status,
      verdict: event.verdict,
      confidence: event.confidence,
      reasons: event.reasons,
      claimCategory: event.claimCategory ?? 'general',
      claimTypeTag: event.claimTypeTag ?? 'other',
      claimTypeConfidence: event.claimTypeConfidence ?? event.confidence ?? 0,
      googleEvidenceState: 'none',
      fredEvidenceState: event.claimCategory === 'economic' ? 'ambiguous' : 'not_applicable',
      fredEvidenceSummary:
        event.claimCategory === 'economic'
          ? 'Awaiting economic evidence enrichment.'
          : 'No economic indicator mapping required for this claim.',
      fredEvidenceSources: [],
      correctedClaim: null,
      aiSummary: null,
      aiVerdict: null,
      aiConfidence: null,
      evidenceBasis: null,
      googleFcVerdict: null,
      googleFcConfidence: null,
      googleFcSummary: null,
      chunkStartSec: event.chunkStartSec,
      chunkStartClock: event.chunkStartClock,
      sources: [],
      summary: null,
      outputApprovalState: 'pending',
      outputPackageStatus: 'none',
      outputPackageId: null,
      outputPackageError: null,
      renderStatus: 'none',
      renderJobId: null,
      artifactUrl: null,
      renderError: null,
      approvedAt: null,
      approvedVersion: null,
      rejectedAt: null,
      detectedAt: event.at,
      updatedAt: event.at,
      version: 1
    });
    claims.set(event.claimId, row);
    return;
  }

  if (event.type === 'claim.researching') {
    const existing = claims.get(event.claimId);
    if (existing) {
      claims.set(event.claimId, withPolicy({
        ...existing,
        status: 'researching',
        updatedAt: event.at,
        version: (existing.version ?? 1) + 1
      }));
    }
    return;
  }

  if (event.type === 'claim.updated') {
    const existing = claims.get(event.claimId) ?? {
      claimId: event.claimId,
      claim: event.claim,
      detectedAt: event.at
    };
    const wasApproved = existing.outputApprovalState === 'approved';
    const nextApprovalState = wasApproved ? 'pending' : existing.outputApprovalState ?? 'pending';
    const resetGeneratedArtifacts = wasApproved;

    claims.set(event.claimId, withPolicy({
      ...existing,
      runId: event.runId ?? existing.runId ?? currentRunId ?? null,
      status: event.status,
      verdict: event.verdict,
      confidence: event.confidence,
      summary: event.summary,
      sources: event.sources,
      requiresProducerApproval: event.requiresProducerApproval,
      claimCategory: event.claimCategory ?? existing.claimCategory ?? 'general',
      claimTypeTag: event.claimTypeTag ?? existing.claimTypeTag ?? 'other',
      claimTypeConfidence:
        event.claimTypeConfidence ?? existing.claimTypeConfidence ?? event.confidence ?? 0,
      googleEvidenceState: event.googleEvidenceState ?? existing.googleEvidenceState ?? 'none',
      fredEvidenceState: event.fredEvidenceState ?? existing.fredEvidenceState ?? 'not_applicable',
      fredEvidenceSummary: event.fredEvidenceSummary ?? existing.fredEvidenceSummary ?? null,
      fredEvidenceSources: event.fredEvidenceSources ?? existing.fredEvidenceSources ?? [],
      correctedClaim: event.correctedClaim ?? existing.correctedClaim ?? null,
      aiSummary: event.aiSummary ?? existing.aiSummary ?? null,
      aiVerdict: event.aiVerdict ?? existing.aiVerdict ?? null,
      aiConfidence: event.aiConfidence ?? existing.aiConfidence ?? null,
      evidenceBasis: event.evidenceBasis ?? existing.evidenceBasis ?? null,
      googleFcVerdict: event.googleFcVerdict ?? existing.googleFcVerdict ?? null,
      googleFcConfidence: event.googleFcConfidence ?? existing.googleFcConfidence ?? null,
      googleFcSummary: event.googleFcSummary ?? existing.googleFcSummary ?? null,
      outputApprovalState: nextApprovalState,
      approvedAt: resetGeneratedArtifacts ? null : existing.approvedAt ?? null,
      approvedVersion: resetGeneratedArtifacts ? null : existing.approvedVersion ?? null,
      outputPackageStatus: resetGeneratedArtifacts ? 'none' : existing.outputPackageStatus ?? 'none',
      outputPackageId: resetGeneratedArtifacts ? null : existing.outputPackageId ?? null,
      outputPackageError: resetGeneratedArtifacts ? null : existing.outputPackageError ?? null,
      renderStatus: resetGeneratedArtifacts ? 'none' : existing.renderStatus ?? 'none',
      renderJobId: resetGeneratedArtifacts ? null : existing.renderJobId ?? null,
      artifactUrl: resetGeneratedArtifacts ? null : existing.artifactUrl ?? null,
      renderError: resetGeneratedArtifacts ? null : existing.renderError ?? null,
      updatedAt: event.at,
      version: (existing.version ?? 1) + 1
    }));
    return;
  }

  if (event.type === 'claim.output_approved') {
    const existing = claims.get(event.claimId);
    if (!existing) {
      return;
    }

    claims.set(event.claimId, withPolicy({
      ...existing,
      outputApprovalState: 'approved',
      approvedAt: event.approvedAt ?? event.at,
      approvedVersion: event.approvedVersion ?? nextClaimVersion(existing),
      rejectedAt: null,
      updatedAt: event.at,
      version: (existing.version ?? 1) + 1
    }));
    return;
  }

  if (event.type === 'claim.output_rejected') {
    const existing = claims.get(event.claimId);
    if (!existing) {
      return;
    }

    claims.set(event.claimId, withPolicy({
      ...existing,
      outputApprovalState: 'rejected',
      approvedAt: null,
      approvedVersion: null,
      rejectedAt: event.rejectedAt ?? event.at,
      updatedAt: event.at,
      version: (existing.version ?? 1) + 1
    }));
    return;
  }

  if (event.type === 'claim.output_package_queued') {
    const existing = claims.get(event.claimId);
    if (!existing) {
      return;
    }

    if (existing.outputApprovalState !== 'approved') {
      return;
    }

    if (
      Number.isInteger(event.claimVersion) &&
      Number.isInteger(existing.approvedVersion) &&
      event.claimVersion !== existing.approvedVersion
    ) {
      return;
    }

    claims.set(event.claimId, withPolicy({
      ...existing,
      outputPackageStatus: 'queued',
      outputPackageId: event.packageId ?? existing.outputPackageId ?? null,
      outputPackageError: null,
      updatedAt: event.at,
      version: (existing.version ?? 1) + 1
    }));
    return;
  }

  if (event.type === 'claim.output_package_ready') {
    const existing = claims.get(event.claimId);
    if (!existing) {
      return;
    }

    if (existing.outputApprovalState !== 'approved') {
      return;
    }

    if (
      Number.isInteger(event.claimVersion) &&
      Number.isInteger(existing.approvedVersion) &&
      event.claimVersion !== existing.approvedVersion
    ) {
      return;
    }

    claims.set(event.claimId, withPolicy({
      ...existing,
      outputPackageStatus: 'ready',
      outputPackageId: event.packageId ?? existing.outputPackageId ?? null,
      outputPackageError: null,
      updatedAt: event.at,
      version: (existing.version ?? 1) + 1
    }));
    return;
  }

  if (event.type === 'claim.output_package_failed') {
    const existing = claims.get(event.claimId);
    if (!existing) {
      return;
    }

    if (existing.outputApprovalState !== 'approved') {
      return;
    }

    if (
      Number.isInteger(event.claimVersion) &&
      Number.isInteger(existing.approvedVersion) &&
      event.claimVersion !== existing.approvedVersion
    ) {
      return;
    }

    claims.set(event.claimId, withPolicy({
      ...existing,
      outputPackageStatus: 'failed',
      outputPackageId: event.packageId ?? existing.outputPackageId ?? null,
      outputPackageError: event.error ?? 'Package generation failed',
      updatedAt: event.at,
      version: (existing.version ?? 1) + 1
    }));
    return;
  }

  if (event.type === 'claim.render_queued') {
    const existing = claims.get(event.claimId);
    if (!existing) {
      return;
    }

    if (existing.outputApprovalState !== 'approved') {
      return;
    }

    if (
      Number.isInteger(event.claimVersion) &&
      Number.isInteger(existing.approvedVersion) &&
      event.claimVersion !== existing.approvedVersion
    ) {
      return;
    }

    claims.set(event.claimId, withPolicy({
      ...existing,
      renderStatus: 'queued',
      renderJobId: event.renderJobId ?? existing.renderJobId ?? null,
      renderError: null,
      updatedAt: event.at,
      version: (existing.version ?? 1) + 1
    }));
    return;
  }

  if (event.type === 'claim.render_ready') {
    const existing = claims.get(event.claimId);
    if (!existing) {
      return;
    }

    if (existing.outputApprovalState !== 'approved') {
      return;
    }

    if (
      Number.isInteger(event.claimVersion) &&
      Number.isInteger(existing.approvedVersion) &&
      event.claimVersion !== existing.approvedVersion
    ) {
      return;
    }

    if (
      existing.renderJobId &&
      event.renderJobId &&
      existing.renderJobId !== event.renderJobId
    ) {
      return;
    }

    claims.set(event.claimId, withPolicy({
      ...existing,
      renderStatus: 'ready',
      renderJobId: event.renderJobId ?? existing.renderJobId ?? null,
      artifactUrl: event.artifactUrl ?? existing.artifactUrl ?? null,
      renderError: null,
      updatedAt: event.at,
      version: (existing.version ?? 1) + 1
    }));
    return;
  }

  if (event.type === 'claim.render_failed') {
    const existing = claims.get(event.claimId);
    if (!existing) {
      return;
    }

    if (existing.outputApprovalState !== 'approved') {
      return;
    }

    if (
      Number.isInteger(event.claimVersion) &&
      Number.isInteger(existing.approvedVersion) &&
      event.claimVersion !== existing.approvedVersion
    ) {
      return;
    }

    if (
      existing.renderJobId &&
      event.renderJobId &&
      existing.renderJobId !== event.renderJobId
    ) {
      return;
    }

    claims.set(event.claimId, withPolicy({
      ...existing,
      renderStatus: 'failed',
      renderJobId: event.renderJobId ?? existing.renderJobId ?? null,
      renderError: event.error ?? 'Render job failed',
      updatedAt: event.at,
      version: (existing.version ?? 1) + 1
    }));
  }
}

function emitEvent(event) {
  let enriched = {
    seq: ++eventSeq,
    ...event
  };

  if (enriched.type === 'pipeline.started') {
    currentRunId = enriched.runId ?? null;
    eventHistory.length = 0;
  }

  updateClaimState(enriched);

  if (enriched.type === 'pipeline.started') {
    activityStore.enqueueRunStart({
      runId: enriched.runId ?? null,
      youtubeUrl: enriched.youtubeUrl ?? null,
      chunkSeconds: enriched.chunkSeconds ?? null,
      model: enriched.model ?? null,
      startedAt: enriched.at
    });
  } else if (enriched.type === 'pipeline.stopped') {
    activityStore.enqueueRunStop({
      runId: enriched.runId ?? currentRunId ?? null,
      reason: enriched.reason ?? null,
      stoppedAt: enriched.at
    });
  }

  if (isClaimEventType(enriched.type) && enriched.claimId) {
    const snapshot = claims.get(enriched.claimId);
    if (snapshot) {
      enriched = {
        ...enriched,
        ...claimSnapshotEventFields(snapshot)
      };
      activityStore.enqueueClaimSnapshot(snapshot);
    }
  }

  eventHistory.push(enriched);
  if (eventHistory.length > 1000) {
    eventHistory.shift();
  }

  activityStore.enqueueEvent(enriched);

  if (enriched.type === 'pipeline.stopped' && (!enriched.runId || enriched.runId === currentRunId)) {
    activePipeline = null;
  }

  const data = `id: ${enriched.seq}\nevent: ${enriched.type}\ndata: ${JSON.stringify(enriched)}\n\n`;
  for (const client of sseClients) {
    try {
      if (!client.destroyed) {
        client.write(data);
      }
    } catch {
      sseClients.delete(client);
    }
  }
}

outputPackageService.setEventHandler(emitEvent);
renderService.setEventHandler(emitEvent);
renderService.setJobUpdateHandler((job) => {
  activityStore.enqueueRenderJob(job);
});

function isValidYoutubeUrl(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    return ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(host);
  } catch {
    return false;
  }
}

async function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk.toString();
      if (raw.length > 1_000_000) {
        reject(new Error('Body too large'));
      }
    });
    request.on('end', () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    request.on('error', reject);
  });
}

async function serveFile(response, filePath) {
  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    const MIME_TYPES = {
      '.html': 'text/html; charset=utf-8',
      '.js':   'text/javascript; charset=utf-8',
      '.css':  'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png':  'image/png',
      '.jpg':  'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif':  'image/gif',
      '.svg':  'image/svg+xml',
      '.ico':  'image/x-icon',
    };
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    response.writeHead(200, {
      'Content-Type': contentType
    });
    response.end(data);
  } catch {
    sendJson(response, 404, { ok: false, error: 'Not found' });
  }
}

const server = http.createServer(async (request, response) => {
  response.on('error', () => {});
  const reqUrl = new URL(request.url, `http://${request.headers.host ?? `${HOST}:${PORT}`}`);
  const pathname = reqUrl.pathname;

  if (request.method === 'GET' && pathname === '/health') {
    const dbStatus = activityStore.getStatus();
    const pipelineStatus = activePipeline?.getStatus?.() ?? null;
    sendJson(response, 200, {
      ok: true,
      running: Boolean(activePipeline?.isRunning()),
      runId: currentRunId,
      claimCount: claims.size,
      hasGeminiKey: Boolean(process.env.GEMINI_API_KEY),
      hasGoogleFactCheckKey: Boolean(process.env.GOOGLE_FACT_CHECK_API_KEY),
      hasFredKey: Boolean(FRED_API_KEY),
      hasTakumiRenderer: Boolean(TAKUMI_RENDER_URL),
      authRequired: Boolean(CONTROL_PASSWORD),
      protectReadEndpoints: PROTECT_READ_ENDPOINTS,
      controlRateLimitPerMin: CONTROL_RATE_LIMIT_PER_MIN,
      maxResearchConcurrency: MAX_RESEARCH_CONCURRENCY,
      claimDetectionThreshold: CLAIM_DETECTION_THRESHOLD,
      ingestState: pipelineStatus?.ingestState ?? 'stopped',
      reconnectAttempt: pipelineStatus?.reconnectAttempt ?? 0,
      ingestReconnectEnabled: pipelineStatus?.reconnectEnabled ?? INGEST_RECONNECT_ENABLED,
      ingestMaxRetries: pipelineStatus?.maxRetries ?? INGEST_MAX_RETRIES,
      ingestRetryBaseMs: INGEST_RETRY_BASE_MS,
      ingestRetryMaxMs: INGEST_RETRY_MAX_MS,
      ingestStallTimeoutMs: INGEST_STALL_TIMEOUT_MS,
      ingestVerboseLogs: INGEST_VERBOSE_LOGS,
      lastIngestExit: pipelineStatus?.lastIngestExit ?? null,
      lastIngestEventAt: pipelineStatus?.lastIngestEventAt ?? null,
      database: dbStatus
    });
    return;
  }

  if (request.method === 'GET' && pathname === '/auth-status') {
    sendJson(response, 200, {
      ok: true,
      authRequired: Boolean(CONTROL_PASSWORD),
      protectReadEndpoints: PROTECT_READ_ENDPOINTS,
      controlRateLimitPerMin: CONTROL_RATE_LIMIT_PER_MIN
    });
    return;
  }

  const controlAuthRequired = requiresControlAuth(pathname, request.method);
  const readAuthRequired = requiresReadAuth(pathname, request.method);
  if (controlAuthRequired || readAuthRequired) {
    const rateLimitResult = enforceControlRateLimit(request, pathname);
    if (!rateLimitResult.ok) {
      response.setHeader('Retry-After', String(rateLimitResult.retryAfterSec));
      sendJson(response, 429, {
        ok: false,
        error: `Rate limit exceeded. Retry in ${rateLimitResult.retryAfterSec}s.`
      });
      return;
    }

    if (!isAuthorizedRequest(request, reqUrl)) {
      sendJson(response, 401, {
        ok: false,
        error: 'Unauthorized. Provide x-control-password header or ?control_password= query.'
      });
      return;
    }
  }

  if (request.method === 'GET' && pathname === '/claims') {
    const rows = Array.from(claims.values()).sort((a, b) =>
      (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')
    );
    sendJson(response, 200, {
      ok: true,
      running: Boolean(activePipeline?.isRunning()),
      runId: currentRunId,
      claims: rows
    });
    return;
  }

  if (request.method === 'GET' && pathname === '/output-packages') {
    const runId = reqUrl.searchParams.get('runId');
    sendJson(response, 200, {
      ok: true,
      packages: outputPackageService.listByRunId(runId)
    });
    return;
  }

  const claimPackageMatch = pathname.match(/^\/claims\/([^/]+)\/output-package$/);
  if (request.method === 'GET' && claimPackageMatch) {
    const claimId = decodeURIComponent(claimPackageMatch[1]);
    const outputPackage = outputPackageService.getByClaimId(claimId);
    if (!outputPackage) {
      sendJson(response, 404, {
        ok: false,
        error: `No output package found for claim: ${claimId}`
      });
      return;
    }

    sendJson(response, 200, {
      ok: true,
      package: outputPackage
    });
    return;
  }

  const claimRenderMatch = pathname.match(/^\/claims\/([^/]+)\/render-job$/);
  if (request.method === 'GET' && claimRenderMatch) {
    const claimId = decodeURIComponent(claimRenderMatch[1]);
    const renderJob = renderService.getByClaimId(claimId);
    if (!renderJob) {
      sendJson(response, 404, {
        ok: false,
        error: `No render job found for claim: ${claimId}`
      });
      return;
    }

    sendJson(response, 200, {
      ok: true,
      renderJob
    });
    return;
  }

  if (request.method === 'GET' && pathname === '/events') {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive'
    });

    response.write('retry: 2000\n\n');

    const lastEventIdRaw = request.headers['last-event-id'];
    const lastEventId =
      typeof lastEventIdRaw === 'string' ? Number.parseInt(lastEventIdRaw, 10) : Number.NaN;

    const replayEvents = Number.isInteger(lastEventId)
      ? eventHistory.filter((event) => event.seq > lastEventId).slice(-200)
      : eventHistory.slice(-25);

    sseClients.add(response);
    response.on('error', () => {
      sseClients.delete(response);
    });

    for (const event of replayEvents) {
      response.write(`id: ${event.seq}\n`);
      response.write(`event: ${event.type}\n`);
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    const heartbeat = setInterval(() => {
      try {
        if (!response.destroyed) {
          response.write(': heartbeat\n\n');
        } else {
          clearInterval(heartbeat);
          sseClients.delete(response);
        }
      } catch {
        clearInterval(heartbeat);
        sseClients.delete(response);
      }
    }, 15000);

    request.on('close', () => {
      clearInterval(heartbeat);
      sseClients.delete(response);
    });

    return;
  }

  if (request.method === 'POST' && pathname === '/start') {
    let body;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      sendJson(response, 400, {
        ok: false,
        error: error.message
      });
      return;
    }

    const youtubeUrl = String(body.youtubeUrl ?? '').trim();
    if (!isValidYoutubeUrl(youtubeUrl)) {
      sendJson(response, 400, {
        ok: false,
        error: 'A valid YouTube URL is required.'
      });
      return;
    }

    if (activePipeline?.isRunning()) {
      sendJson(response, 409, {
        ok: false,
        error: 'Pipeline is already running. Stop it before starting a new stream.'
      });
      return;
    }

    claims.clear();
    outputPackageService.clear();
    renderService.clear();
    eventHistory.length = 0;
    currentRunId = null;

    activePipeline = createPipeline({
      youtubeUrl,
      geminiApiKey: process.env.GEMINI_API_KEY,
      geminiModel: process.env.GEMINI_TRANSCRIBE_MODEL,
      factCheckApiKey: process.env.GOOGLE_FACT_CHECK_API_KEY,
      fredApiKey: FRED_API_KEY,
      chunkSeconds: CHUNK_SECONDS,
      maxResearchConcurrency: MAX_RESEARCH_CONCURRENCY,
      claimDetectionThreshold: CLAIM_DETECTION_THRESHOLD,
      ingestReconnectEnabled: INGEST_RECONNECT_ENABLED,
      ingestMaxRetries: INGEST_MAX_RETRIES,
      ingestRetryBaseMs: INGEST_RETRY_BASE_MS,
      ingestRetryMaxMs: INGEST_RETRY_MAX_MS,
      ingestStallTimeoutMs: INGEST_STALL_TIMEOUT_MS,
      ingestVerboseLogs: INGEST_VERBOSE_LOGS,
      geminiVerifyModel: process.env.GEMINI_VERIFY_MODEL,
      onEvent: emitEvent
    });

    try {
      activePipeline.start();
    } catch (error) {
      activePipeline = null;
      sendJson(response, 500, {
        ok: false,
        error: error.message
      });
      return;
    }

    sendJson(response, 202, {
      ok: true,
      runId: activePipeline.runId
    });
    return;
  }

  if (request.method === 'POST' && pathname === '/stop') {
    if (activePipeline?.isRunning()) {
      try {
        activePipeline.stop('user_requested_stop');
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(`[stop] pipeline.stop() error: ${error.message}`);
        activePipeline = null;
      }
    }

    sendJson(response, 200, {
      ok: true,
      running: Boolean(activePipeline?.isRunning())
    });
    return;
  }

  const claimActionMatch = pathname.match(
    /^\/claims\/([^/]+)\/(approve-output|reject-output|generate-package|render-image|tag-override)$/
  );
  if (request.method === 'POST' && claimActionMatch) {
    let body = {};
    try {
      body = await readJsonBody(request);
    } catch (error) {
      sendJson(response, 400, {
        ok: false,
        error: error.message
      });
      return;
    }

    const claimId = decodeURIComponent(claimActionMatch[1]);
    const action = claimActionMatch[2];
    const existingRaw = claims.get(claimId);
    const existing = existingRaw ? withPolicy(existingRaw) : null;
    const actorId = actorIdFromRequest(request);
    const reason =
      typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 600) : null;
    const expectedVersion = parseExpectedVersion(body.expectedVersion);

    const logResult = (result, extra = {}) => {
      logClaimAction({
        runId: existing?.runId ?? currentRunId ?? null,
        claimId,
        action,
        actorId,
        reason,
        expectedVersion,
        result,
        ...extra
      });
    };

    if (!existing) {
      logResult('failed_not_found');
      sendJson(response, 404, {
        ok: false,
        error: `Claim not found: ${claimId}`
      });
      return;
    }

    if (expectedVersion === null) {
      logResult('failed_missing_expected_version', {
        currentVersion: existing.version
      });
      sendJson(response, 400, {
        ok: false,
        error: 'expectedVersion is required for claim actions to prevent stale mutations.'
      });
      return;
    }

    if (expectedVersion !== null && expectedVersion !== existing.version) {
      logResult('failed_version_conflict', {
        currentVersion: existing.version
      });
      sendJson(response, 409, {
        ok: false,
        error: `Claim state changed. Expected version=${expectedVersion}, current=${existing.version}.`
      });
      return;
    }

    if (action === 'tag-override') {
      const requestedTag =
        typeof body.tag === 'string' ? body.tag.trim().toLowerCase() : '';
      if (!isValidClaimTypeTag(requestedTag)) {
        logResult('failed_invalid_tag', {
          providedTag: requestedTag || null
        });
        sendJson(response, 400, {
          ok: false,
          error: 'Tag must be one of: numeric_factual, simple_policy, other.'
        });
        return;
      }

      if (!reason) {
        logResult('failed_missing_reason');
        sendJson(response, 400, {
          ok: false,
          error: 'A non-empty reason is required for tag override.'
        });
        return;
      }

      if (existing.outputApprovalState === 'approved') {
        logResult('failed_approved_locked');
        sendJson(response, 409, {
          ok: false,
          error:
            'Claim is already approved. Reject output first before changing policy classification.'
        });
        return;
      }

      emitEvent(buildClaimEventPayload('claim.updated', existing, {
        claimTypeTag: requestedTag,
        claimTypeConfidence: existing.claimTypeConfidence ?? existing.confidence ?? 0,
        status: existing.status,
        requiresProducerApproval: true
      }));

      const updatedClaim = claims.get(claimId);
      logResult('succeeded', {
        claimTypeTag: requestedTag
      });
      sendJson(response, 200, {
        ok: true,
        claim: updatedClaim
      });
      return;
    }

    if (action === 'generate-package') {
      const policy = withPolicy(existing);
      if (!policy.exportEligibility) {
        const reasonCode = policy.exportBlockReason ?? 'blocked';
        logResult(`failed_${reasonCode}`);
        sendJson(response, 409, {
          ok: false,
          error: policyBlockMessage(reasonCode, policy)
        });
        return;
      }

      const approvedVersion = Number.isInteger(policy.approvedVersion) ? policy.approvedVersion : null;
      if (!approvedVersion) {
        logResult('failed_missing_approved_version');
        sendJson(response, 409, {
          ok: false,
          error: 'Claim approval is stale. Re-approve the latest researched claim before exporting.'
        });
        return;
      }

      const generated = await outputPackageService.queueForClaim(
        {
          ...policy,
          version: approvedVersion
        },
        {
          runId: existing.runId
        }
      );
      activityStore.enqueueOutputPackage(generated);
      logResult('succeeded', {
        packageId: generated.packageId
      });

      sendJson(response, 200, {
        ok: true,
        claim: claims.get(claimId),
        package: generated
      });
      return;
    }

    if (action === 'render-image') {
      const policy = withPolicy(existing);
      if (!policy.exportEligibility) {
        const reasonCode = policy.exportBlockReason ?? 'blocked';
        logResult(`failed_${reasonCode}`);
        sendJson(response, 409, {
          ok: false,
          error: policyBlockMessage(reasonCode, policy)
        });
        return;
      }

      const approvedVersion = Number.isInteger(policy.approvedVersion) ? policy.approvedVersion : null;
      if (!approvedVersion) {
        logResult('failed_missing_approved_version');
        sendJson(response, 409, {
          ok: false,
          error: 'Claim approval is stale. Re-approve the latest researched claim before rendering.'
        });
        return;
      }

      const force = Boolean(body.force);
      const currentJob = renderService.getByClaimId(claimId);
      if (!force && currentJob && (currentJob.status === 'queued' || currentJob.status === 'rendering')) {
        logResult('noop_render_inflight', {
          renderJobId: currentJob.renderJobId
        });
        sendJson(response, 202, {
          ok: true,
          claim: claims.get(claimId),
          renderJob: currentJob
        });
        return;
      }

      let outputPackage = outputPackageService.getByClaimId(claimId);
      if (!outputPackage || outputPackage.status !== 'ready') {
        outputPackage = await outputPackageService.queueForClaim(
          {
            ...policy,
            version: approvedVersion
          },
          {
            runId: policy.runId
          }
        );
        activityStore.enqueueOutputPackage(outputPackage);
      }

      if (!outputPackage || outputPackage.status !== 'ready') {
        logResult('failed_package_generation');
        sendJson(response, 502, {
          ok: false,
          error: outputPackage?.error ?? 'Package generation failed.'
        });
        return;
      }

      const claimForRender = {
        ...policy,
        version: approvedVersion,
        renderTemplateId: outputPackage?.templateVersion ?? 'fc-lower-third-v1',
        renderPayload: outputPackage?.payload?.fields ?? outputPackage?.payload ?? null
      };

      const renderJob = await renderService.queueRender(claimForRender, {
        runId: policy.runId,
        force,
        forceNonce:
          typeof body.forceNonce === 'string' && body.forceNonce.trim()
            ? body.forceNonce.trim().slice(0, 80)
            : undefined
      });

      logResult('succeeded', {
        renderJobId: renderJob.renderJobId,
        rendererMode: renderJob.rendererMode ?? null
      });
      sendJson(response, 202, {
        ok: true,
        claim: claims.get(claimId),
        package: outputPackage,
        renderJob
      });
      return;
    }

    if (action === 'approve-output') {
      if (existing.outputApprovalState === 'approved') {
        logResult('noop_already_approved');
        sendJson(response, 200, {
          ok: true,
          claim: existing,
          package: outputPackageService.getByClaimId(claimId),
          renderJob: renderService.getByClaimId(claimId)
        });
        return;
      }

      const policy = withPolicy(existing);
      if (!policy.approvalEligibility) {
        const reasonCode = policy.approvalBlockReason ?? 'blocked';
        logResult(`failed_${reasonCode}`);
        sendJson(response, 409, {
          ok: false,
          error: policyBlockMessage(reasonCode, policy)
        });
        return;
      }

      emitEvent(buildClaimEventPayload('claim.output_approved', policy, {
        outputApprovalState: 'approved',
        approvedAt: new Date().toISOString(),
        approvedVersion: nextClaimVersion(policy)
      }));

      const updatedClaim = claims.get(claimId);
      const approvedVersion = Number.isInteger(updatedClaim?.approvedVersion)
        ? updatedClaim.approvedVersion
        : null;
      const generatedPackage = await outputPackageService.queueForClaim(
        {
          ...updatedClaim,
          version: approvedVersion ?? updatedClaim?.version ?? null
        },
        {
          runId: existing.runId
        }
      );
      activityStore.enqueueOutputPackage(generatedPackage);

      if (generatedPackage.status !== 'ready') {
        logResult('failed_package_generation', {
          packageId: generatedPackage.packageId
        });
        sendJson(response, 502, {
          ok: false,
          claim: claims.get(claimId),
          package: generatedPackage,
          error: generatedPackage.error ?? 'Package generation failed'
        });
        return;
      }

      const renderJob = await renderService.queueRender(
        {
          ...updatedClaim,
          version: approvedVersion ?? updatedClaim?.version ?? null,
          renderTemplateId: generatedPackage?.templateVersion ?? 'fc-lower-third-v1',
          renderPayload: generatedPackage?.payload?.fields ?? generatedPackage?.payload ?? null
        },
        {
          runId: existing.runId
        }
      );

      logResult('succeeded', {
        packageId: generatedPackage.packageId,
        renderJobId: renderJob.renderJobId
      });

      sendJson(response, 200, {
        ok: true,
        claim: claims.get(claimId),
        package: generatedPackage,
        renderJob
      });
      return;
    }

    if (action !== 'reject-output') {
      logResult('failed_invalid_action');
      sendJson(response, 404, {
        ok: false,
        error: `Unsupported claim action: ${action}`
      });
      return;
    }

    if (existing.outputApprovalState === 'rejected') {
      logResult('noop_already_rejected');
      sendJson(response, 200, {
        ok: true,
        claim: existing
      });
      return;
    }

    emitEvent(buildClaimEventPayload('claim.output_rejected', existing, {
      outputApprovalState: 'rejected',
      rejectedAt: new Date().toISOString()
    }));
    logResult('succeeded');

    sendJson(response, 200, {
      ok: true,
      claim: claims.get(claimId)
    });
    return;
  }

  if (request.method === 'GET' && pathname === '/') {
    await serveFile(response, path.join(publicDir, 'control.html'));
    return;
  }

  if (request.method === 'GET' && pathname === '/overlay') {
    await serveFile(response, path.join(publicDir, 'overlay.html'));
    return;
  }

  // Catch-all: serve static files from public/
  if (request.method === 'GET') {
    const safePath = path.normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, '');
    const filePath = path.join(publicDir, safePath);
    if (filePath.startsWith(publicDir)) {
      await serveFile(response, filePath);
      return;
    }
  }

  sendJson(response, 404, { ok: false, error: 'Not found' });
});

process.on('uncaughtException', (error) => {
  // eslint-disable-next-line no-console
  console.error(`[uncaughtException] ${error.stack ?? error.message}`);
});

process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error(`[unhandledRejection] ${reason?.stack ?? reason}`);
});

server.on('clientError', (error, socket) => {
  if (!socket.destroyed) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  }
});

async function hydrateStateFromStore() {
  await activityStore.init();

  const storedClaims = await activityStore.loadLatestRunClaims(1000);
  if (!Array.isArray(storedClaims) || storedClaims.length === 0) {
    return;
  }

  claims.clear();
  currentRunId = null;

  for (const claim of storedClaims) {
    if (!claim || typeof claim !== 'object' || !claim.claimId) {
      continue;
    }

    const normalized = withPolicy({
      ...claim,
      outputApprovalState: claim.outputApprovalState ?? 'pending',
      outputPackageStatus: claim.outputPackageStatus ?? 'none',
      renderStatus: claim.renderStatus ?? 'none',
      version: Number.isInteger(claim.version) ? claim.version : 1
    });
    claims.set(normalized.claimId, normalized);
    if (!currentRunId && normalized.runId) {
      currentRunId = normalized.runId;
    }
  }
}

async function bootstrap() {
  try {
    await hydrateStateFromStore();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`startup hydration failed: ${error.message}`);
  }

  server.listen(PORT, HOST, () => {
    // eslint-disable-next-line no-console
    console.log(`sotu-factcheck-prototype listening on http://${HOST}:${PORT}`);
  });
}

void bootstrap();
