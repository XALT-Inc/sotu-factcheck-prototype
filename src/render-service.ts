import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RenderJob, RenderServiceOptions, PipelineEvent, ClaimForOutput } from './types.js';
import { buildFactcheckGraphic, VERDICT_STYLES } from './graphic-template.js';
import { normalizeClaimVersion, createEmitter } from './utils.js';
import { claimToRenderData, buildDefaultRenderPayload } from './claim-payload.js';
import { RENDER_JOB_TTL_MS, RENDER_CLEANUP_INTERVAL_MS, CLAIM_TEXT_LIMIT, DEFAULT_TEMPLATE_VERSION } from './constants.js';
import { createLogger } from './logger.js';

const log = createLogger('render-service');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Satori font loading ────────────────────────────────────────────────────

let satoriModule: typeof import('satori') | null = null;
let resvgModule: typeof import('@resvg/resvg-js') | null = null;
let fontData: ArrayBuffer | null = null;

async function loadSatoriDeps(): Promise<boolean> {
  if (satoriModule && resvgModule && fontData) return true;
  try {
    satoriModule = await import('satori');
    resvgModule = await import('@resvg/resvg-js');
    // Try to load Roboto font, fall back to a system font data
    try {
      const __dirname = dirname(fileURLToPath(import.meta.url));
      const fontPath = join(__dirname, '..', 'fonts', 'Roboto-Regular.ttf');
      fontData = (await readFile(fontPath)).buffer as ArrayBuffer;
    } catch {
      // If no local font, fetch from Google Fonts CDN
      try {
        const res = await fetch('https://fonts.gstatic.com/s/roboto/v47/KFOMCnqEu92Fr1ME7kSn66aGLdTylUAMQXC89YmC2DPNWubEbGmT.ttf');
        fontData = await res.arrayBuffer();
      } catch {
        log.warn('Could not load Roboto font, satori rendering may use fallback');
        // Create minimal empty font data — satori requires at least one font
        fontData = new ArrayBuffer(0);
        return false;
      }
    }
    return true;
  } catch (err) {
    log.error({ err }, 'Failed to load satori/resvg dependencies');
    return false;
  }
}

async function renderWithSatori(claim: ClaimForOutput): Promise<string> {
  const ready = await loadSatoriDeps();
  if (!ready || !satoriModule || !resvgModule || !fontData || fontData.byteLength === 0) {
    throw new Error('Satori rendering not available — font loading failed');
  }

  const satori = satoriModule.default;
  const { Resvg } = resvgModule;

  const markup = buildFactcheckGraphic(claimToRenderData(claim));
  const svg = await satori(markup, {
    width: 1920,
    height: 1080,
    fonts: [{ name: 'Roboto', data: fontData, weight: 400, style: 'normal' }],
  });

  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: 1920 } });
  const png = resvg.render().asPng();
  return `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
}

// Keep SVG fallback for when satori is unavailable
function localFallbackSvgArtifact(claim: ClaimForOutput): string {
  const verdict = String(claim.verdict ?? 'unverified').toLowerCase();
  const claimText = String(claim.claim ?? '').slice(0, CLAIM_TEXT_LIMIT);
  const escaped = (value: string) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const vc = VERDICT_STYLES[verdict] || VERDICT_STYLES.unverified;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080">
  <rect width="100%" height="100%" fill="#0f172a"/>
  <text x="80" y="80" fill="#e2e8f0" font-family="Arial,sans-serif" font-size="32" font-weight="700">FACT CHECKER</text>
  <rect x="80" y="140" width="${vc.label.length * 16 + 32}" height="36" fill="${vc.bg}" rx="6"/>
  <text x="${80 + (vc.label.length * 16 + 32) / 2}" y="165" fill="${vc.text}" font-family="Arial,sans-serif" font-size="18" font-weight="700" text-anchor="middle">${escaped(vc.label)}</text>
  <text x="80" y="230" fill="#e2e8f0" font-family="Arial,sans-serif" font-size="28">${escaped(claimText.slice(0, 120))}</text>
</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function buildIdempotencyKey(claim: ClaimForOutput): string {
  const claimId = String(claim?.claimId ?? '').trim() || 'claim-unknown';
  const version = normalizeClaimVersion(claim.version);
  const templateId = String(claim?.renderTemplateId ?? DEFAULT_TEMPLATE_VERSION).trim();
  return `${claimId}:${version}:${templateId}`;
}

async function callTakumiRenderer(
  claim: ClaimForOutput,
  options: { takumiRenderUrl: string; timeoutMs: number }
): Promise<{ artifactUrl: string; rendererMode: string }> {
  const endpoint = String(options.takumiRenderUrl ?? '').trim();
  if (!endpoint) {
    // Try satori PNG, fall back to SVG if unavailable
    try {
      const artifactUrl = await renderWithSatori(claim);
      return { artifactUrl, rendererMode: 'satori' };
    } catch {
      return { artifactUrl: localFallbackSvgArtifact(claim), rendererMode: 'local_svg_fallback' };
    }
  }

  const controller = new AbortController();
  const timeoutMs = Math.max(1000, options.timeoutMs ?? 5000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        claimId: claim.claimId,
        runId: claim.runId,
        templateId: claim.renderTemplateId ?? DEFAULT_TEMPLATE_VERSION,
        payload: claim.renderPayload ?? buildDefaultRenderPayload(claim),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 220);
      throw new Error(`Takumi render failed (${response.status}): ${detail}`);
    }

    const contentType = String(response.headers.get('content-type') ?? '').toLowerCase();
    if (contentType.startsWith('image/')) {
      const imageBytes = await response.arrayBuffer();
      return {
        artifactUrl: `data:${contentType};base64,${Buffer.from(imageBytes).toString('base64')}`,
        rendererMode: 'takumi_remote',
      };
    }

    const body = (await response.json()) as Record<string, unknown>;
    if (typeof body.artifactUrl === 'string' && (body.artifactUrl as string).trim()) {
      return { artifactUrl: (body.artifactUrl as string).trim(), rendererMode: 'takumi_remote' };
    }
    if (typeof body.imageBase64 === 'string' && (body.imageBase64 as string).trim()) {
      const mime = typeof body.mimeType === 'string' && (body.mimeType as string).trim() ? body.mimeType as string : 'image/png';
      return { artifactUrl: `data:${mime};base64,${(body.imageBase64 as string).trim()}`, rendererMode: 'takumi_remote' };
    }
    throw new Error('Takumi response missing artifactUrl/imageBase64.');
  } finally {
    clearTimeout(timer);
  }
}

export interface RenderService {
  queueRender: (claim: ClaimForOutput, context?: Record<string, unknown>) => Promise<RenderJob>;
  getByClaimId: (claimId: string) => RenderJob | null;
  clear: () => void;
  setEventHandler: (handler: (event: PipelineEvent) => void) => void;
  setJobUpdateHandler: (handler: (job: RenderJob) => void) => void;
}

export function createRenderService(options: RenderServiceOptions = {}): RenderService {
  const jobsByClaimId = new Map<string, RenderJob>();
  const jobsByRenderJobId = new Map<string, RenderJob>();
  const jobsByIdempotencyKey = new Map<string, string>();
  let onEvent = options.onEvent;
  let onJobUpdate = options.onJobUpdate;
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const timeoutMs = Math.max(1000, options.timeoutMs ?? 5000);
  const retryDelayMs = Math.max(100, options.retryDelayMs ?? 350);
  const takumiRenderUrl = options.takumiRenderUrl ?? '';

  // TTL cleanup for completed render jobs
  let cleanupTimer: ReturnType<typeof setInterval> | null = null;

  function startCleanup(): void {
    if (cleanupTimer) return;
    cleanupTimer = setInterval(() => {
      const cutoff = Date.now() - RENDER_JOB_TTL_MS;
      for (const [id, job] of jobsByRenderJobId) {
        if ((job.status === 'ready' || job.status === 'failed') && new Date(job.updatedAt).getTime() < cutoff) {
          jobsByRenderJobId.delete(id);
          if (jobsByClaimId.get(job.claimId)?.renderJobId === id) {
            jobsByClaimId.delete(job.claimId);
          }
          if (job.idempotencyKey) jobsByIdempotencyKey.delete(job.idempotencyKey);
        }
      }
    }, RENDER_CLEANUP_INTERVAL_MS);
    if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();
  }

  startCleanup();

  let emit = createEmitter(onEvent);

  function persistJob(job: RenderJob): void {
    onJobUpdate?.(job);
  }

  function storeJob(job: RenderJob): void {
    jobsByClaimId.set(job.claimId, job);
    jobsByRenderJobId.set(job.renderJobId, job);
    if (job.idempotencyKey) jobsByIdempotencyKey.set(job.idempotencyKey, job.renderJobId);
    persistJob(job);
  }

  async function processJob(claimId: string, renderJobId: string): Promise<void> {
    let current = jobsByRenderJobId.get(renderJobId);
    if (!current || current.claimId !== claimId || current.status !== 'queued') return;
    const latestForClaim = jobsByClaimId.get(claimId);
    if (!latestForClaim || latestForClaim.renderJobId !== renderJobId) return;

    current = { ...current, status: 'rendering', updatedAt: new Date().toISOString() };
    storeJob(current);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const active = jobsByRenderJobId.get(renderJobId);
      const latestForClaimNow = jobsByClaimId.get(claimId);
      if (!active || !latestForClaimNow || latestForClaimNow.renderJobId !== renderJobId || active.claimId !== claimId) return;

      try {
        const result = await callTakumiRenderer(active.claim as unknown as ClaimForOutput, { takumiRenderUrl, timeoutMs });
        const latest = jobsByRenderJobId.get(renderJobId);
        const latestClaim = jobsByClaimId.get(claimId);
        if (!latest || !latestClaim || latestClaim.renderJobId !== renderJobId || latest.claimId !== claimId) return;

        const ready: RenderJob = {
          ...latest, attempts: attempt, status: 'ready',
          rendererMode: result.rendererMode, artifactUrl: result.artifactUrl,
          error: null, updatedAt: new Date().toISOString(),
        };
        storeJob(ready);
        emit('claim.render_ready', {
          claimId, runId: ready.runId, renderJobId: ready.renderJobId,
          renderStatus: 'ready', artifactUrl: ready.artifactUrl,
          claimVersion: ready.claimVersion, idempotencyKey: ready.idempotencyKey,
        });
        return;
      } catch (error) {
        const latest = jobsByRenderJobId.get(renderJobId);
        const latestClaim = jobsByClaimId.get(claimId);
        if (!latest || !latestClaim || latestClaim.renderJobId !== renderJobId || latest.claimId !== claimId) return;

        if (attempt >= maxAttempts) {
          const failed: RenderJob = {
            ...latest, attempts: attempt, status: 'failed',
            error: (error as Error).message, updatedAt: new Date().toISOString(),
          };
          storeJob(failed);
          emit('claim.render_failed', {
            claimId, runId: failed.runId, renderJobId: failed.renderJobId,
            renderStatus: 'failed', error: failed.error,
            claimVersion: failed.claimVersion, idempotencyKey: failed.idempotencyKey,
          });
          return;
        }
      }

      await sleep(retryDelayMs * attempt);
      current = jobsByRenderJobId.get(renderJobId) ?? current;
      if (current.renderJobId !== renderJobId) return;
    }
  }

  async function queueRender(claim: ClaimForOutput, context: Record<string, unknown> = {}): Promise<RenderJob> {
    const normalizedClaim = {
      ...claim,
      renderTemplateId: claim.renderTemplateId ?? DEFAULT_TEMPLATE_VERSION,
      renderPayload: claim.renderPayload ?? buildDefaultRenderPayload(claim),
    };
    const claimVersion = normalizeClaimVersion(normalizedClaim.version);
    const force = Boolean(context.force);
    const baseIdempotencyKey =
      typeof context.idempotencyKey === 'string' && (context.idempotencyKey as string).trim()
        ? (context.idempotencyKey as string).trim()
        : buildIdempotencyKey(normalizedClaim);
    const idempotencyKey = force
      ? `${baseIdempotencyKey}:force:${(context.forceNonce as string) ?? randomUUID().slice(0, 8)}`
      : baseIdempotencyKey;

    const now = new Date().toISOString();

    if (!force) {
      const existingJobId = jobsByIdempotencyKey.get(baseIdempotencyKey);
      if (existingJobId) {
        const existing = jobsByRenderJobId.get(existingJobId);
        if (existing) {
          if (existing.status !== 'failed') return existing;
          const retried: RenderJob = {
            ...existing,
            runId: (context.runId as string) ?? existing.runId ?? normalizedClaim.runId ?? null,
            claim: normalizedClaim as unknown as Record<string, unknown>,
            claimVersion, idempotencyKey: baseIdempotencyKey,
            status: 'queued', error: null, updatedAt: now,
          };
          storeJob(retried);
          emit('claim.render_queued', {
            claimId: normalizedClaim.claimId, runId: retried.runId,
            renderJobId: retried.renderJobId, renderStatus: 'queued',
            claimVersion: retried.claimVersion, idempotencyKey: retried.idempotencyKey,
          });
          void processJob(normalizedClaim.claimId, retried.renderJobId);
          return retried;
        }
      }
    }

    const renderJob: RenderJob = {
      renderJobId: randomUUID(),
      claimId: normalizedClaim.claimId,
      runId: (context.runId as string) ?? normalizedClaim.runId ?? null,
      claimVersion, idempotencyKey,
      status: 'queued', attempts: 0,
      claim: normalizedClaim as unknown as Record<string, unknown>,
      artifactUrl: null, error: null, rendererMode: null,
      createdAt: now, updatedAt: now,
    };

    storeJob(renderJob);
    emit('claim.render_queued', {
      claimId: normalizedClaim.claimId, runId: renderJob.runId,
      renderJobId: renderJob.renderJobId, renderStatus: 'queued',
      claimVersion: renderJob.claimVersion, idempotencyKey: renderJob.idempotencyKey,
    });

    void processJob(normalizedClaim.claimId, renderJob.renderJobId);
    return renderJob;
  }

  function getByClaimId(claimId: string): RenderJob | null {
    return jobsByClaimId.get(claimId) ?? null;
  }

  function clear(): void {
    jobsByClaimId.clear();
    jobsByRenderJobId.clear();
    jobsByIdempotencyKey.clear();
  }

  function setEventHandler(handler: (event: PipelineEvent) => void): void {
    onEvent = handler;
    emit = createEmitter(onEvent);
  }

  function setJobUpdateHandler(handler: (job: RenderJob) => void): void {
    onJobUpdate = handler;
  }

  return { queueRender, getByClaimId, clear, setEventHandler, setJobUpdateHandler };
}
