import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyRateLimit from '@fastify/rate-limit';

import { getEnv } from './env.js';
import { createActivityStore } from './activity-store.js';
import { createOutputPackageService } from './output-package-service.js';
import { createRenderService } from './render-service.js';
import { createPipelineRegistry } from './pipeline-registry.js';
import * as claimState from './claim-state.js';
import { createLogger } from './logger.js';
import type { PipelineEvent, PipelineInstance } from './types.js';

import { createSseManager } from './server/sse.js';
import { isControlAction, isReadProtected, registerAuthHook } from './server/auth.js';
import { createEmitEvent, withPolicy } from './server/claim-events.js';
import { registerRoutes } from './server/routes.js';

const env = getEnv();
const log = createLogger('server');

// ── Global state ───────────────────────────────────────────────────────────

const pipelineRegistry = createPipelineRegistry({
  takumiRenderUrl: env.TAKUMI_RENDER_URL,
  renderTimeoutMs: env.RENDER_TIMEOUT_MS,
});

let defaultPipelineId: string | null = null;
let currentRunId: string | null = null;
let currentOverlayKey: string | null = null;
let currentYoutubeUrl: string | null = null;
let currentStartedAt: string | null = null;
let eventSeq = 0;
const eventHistory: PipelineEvent[] = [];

const outputPackageService = createOutputPackageService();
const renderService = createRenderService({ takumiRenderUrl: env.TAKUMI_RENDER_URL, timeoutMs: env.RENDER_TIMEOUT_MS });
const activityStore = createActivityStore({ databaseUrl: env.DATABASE_URL, onError: (error) => { log.error({ err: error }, 'activity-store error'); } });
const sseManager = createSseManager();

function getActivePipeline(): PipelineInstance | null {
  if (!defaultPipelineId) return null;
  const entry = pipelineRegistry.get(defaultPipelineId);
  return entry?.pipeline ?? null;
}

claimState.startCleanupInterval();

// ── Event pipeline ─────────────────────────────────────────────────────────

const emitEvent = createEmitEvent({
  pipelineRegistry,
  activityStore,
  sseManager,
  eventHistory,
  getEventSeq: () => ++eventSeq,
  getCurrentRunId: () => currentRunId,
  setCurrentRunId: (id) => { currentRunId = id; },
  getDefaultPipelineId: () => defaultPipelineId,
  setDefaultPipelineId: (id) => { defaultPipelineId = id; },
  setCurrentOverlayKey: (key) => { currentOverlayKey = key; },
  setCurrentYoutubeUrl: (url) => { currentYoutubeUrl = url; },
  setCurrentStartedAt: (at) => { currentStartedAt = at; },
});

outputPackageService.setEventHandler(emitEvent);
renderService.setEventHandler(emitEvent);
renderService.setJobUpdateHandler((job) => { activityStore.enqueueRenderJob(job as unknown as Record<string, unknown>); });

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
    return !isControlAction(url, request.method) && !isReadProtected(url, request.method, env.PROTECT_READ_ENDPOINTS);
  },
});

registerAuthHook(app, { controlPassword: env.CONTROL_PASSWORD, protectReadEndpoints: env.PROTECT_READ_ENDPOINTS });

await registerRoutes(app, {
  env: env as unknown as Record<string, unknown>,
  pipelineRegistry,
  activityStore,
  outputPackageService,
  renderService,
  sseManager,
  eventHistory,
  emitEvent,
  getActivePipeline,
  getCurrentRunId: () => currentRunId,
  getCurrentOverlayKey: () => currentOverlayKey,
  setDefaultPipelineId: (id) => { defaultPipelineId = id; },
  setCurrentOverlayKey: (key) => { currentOverlayKey = key; },
  setCurrentYoutubeUrl: (url) => { currentYoutubeUrl = url; },
  setCurrentStartedAt: (at) => { currentStartedAt = at; },
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
    } as import('./types.js').Claim);
    claimState.setClaim(normalized.claimId, normalized);
    if (!currentRunId && normalized.runId) currentRunId = normalized.runId;
  }
}

async function bootstrap(): Promise<void> {
  try { await hydrateStateFromStore(); } catch (error) { log.error({ err: error }, 'startup hydration failed'); }

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
