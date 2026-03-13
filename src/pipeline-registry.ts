import { randomBytes } from 'node:crypto';

import { createPipeline } from './pipeline.js';
import { createOutputPackageService, type OutputPackageService } from './output-package-service.js';
import { createRenderService, type RenderService } from './render-service.js';
import { createLogger } from './logger.js';
import type { PipelineConfig, PipelineInstance, PipelineEvent } from './types.js';

const log = createLogger('pipeline-registry');

// ── Types ────────────────────────────────────────────────────────────────────

export interface PipelineEntry {
  pipelineId: string;
  pipeline: PipelineInstance;
  runId: string;
  overlayKey: string;
  youtubeUrl: string | null;
  outputPackageService: OutputPackageService;
  renderService: RenderService;
  createdAt: string;
}

export interface PipelineRegistryOptions {
  takumiRenderUrl?: string;
  renderTimeoutMs?: number;
}

export interface PipelineRegistry {
  /** Start a new pipeline, returns the entry. */
  start(pipelineId: string, config: PipelineConfig): PipelineEntry;

  /** Stop a pipeline by id. Returns true if it was running. */
  stop(pipelineId: string, reason?: string): boolean;

  /** Get a pipeline entry by id. */
  get(pipelineId: string): PipelineEntry | undefined;

  /** Look up a pipeline entry by its overlay key. */
  getByOverlayKey(overlayKey: string): PipelineEntry | undefined;

  /** Look up a pipeline entry by its runId. */
  getByRunId(runId: string): PipelineEntry | undefined;

  /** List all pipeline entries. */
  list(): PipelineEntry[];

  /** Check if a pipeline is running. */
  isRunning(pipelineId: string): boolean;

  /** Remove a stopped pipeline from the registry. */
  remove(pipelineId: string): boolean;

  /** Stop all pipelines (for shutdown). */
  stopAll(reason?: string): void;

  /** Number of registered pipelines. */
  size(): number;
}

// ── Overlay key generation ───────────────────────────────────────────────────

function generateOverlayKey(): string {
  return randomBytes(16).toString('hex');
}

// ── Registry implementation ──────────────────────────────────────────────────

export function createPipelineRegistry(options: PipelineRegistryOptions = {}): PipelineRegistry {
  const entries = new Map<string, PipelineEntry>();
  const overlayKeyIndex = new Map<string, string>(); // overlayKey -> pipelineId

  function start(pipelineId: string, config: PipelineConfig): PipelineEntry {
    const existing = entries.get(pipelineId);
    if (existing?.pipeline.isRunning()) {
      throw new Error(`Pipeline ${pipelineId} is already running. Stop it before starting a new one.`);
    }

    // Clean up old entry if it exists
    if (existing) {
      overlayKeyIndex.delete(existing.overlayKey);
    }

    const overlayKey = generateOverlayKey();
    const outputPackageService = createOutputPackageService();
    const renderService = createRenderService({
      takumiRenderUrl: options.takumiRenderUrl,
      timeoutMs: options.renderTimeoutMs,
    });

    const pipeline = createPipeline(config);

    const entry: PipelineEntry = {
      pipelineId,
      pipeline,
      runId: pipeline.runId,
      overlayKey,
      youtubeUrl: config.youtubeUrl ?? null,
      outputPackageService,
      renderService,
      createdAt: new Date().toISOString(),
    };

    entries.set(pipelineId, entry);
    overlayKeyIndex.set(overlayKey, pipelineId);

    try {
      pipeline.start();
    } catch (error) {
      entries.delete(pipelineId);
      overlayKeyIndex.delete(overlayKey);
      throw error;
    }

    log.info({ pipelineId, runId: pipeline.runId, overlayKey }, 'pipeline registered and started');
    return entry;
  }

  function stop(pipelineId: string, reason = 'manual_stop'): boolean {
    const entry = entries.get(pipelineId);
    if (!entry?.pipeline.isRunning()) return false;
    try {
      entry.pipeline.stop(reason);
    } catch (error) {
      log.error({ err: error, pipelineId }, 'pipeline.stop() error');
    }
    return true;
  }

  function get(pipelineId: string): PipelineEntry | undefined {
    return entries.get(pipelineId);
  }

  function getByOverlayKey(overlayKey: string): PipelineEntry | undefined {
    const pipelineId = overlayKeyIndex.get(overlayKey);
    if (!pipelineId) return undefined;
    return entries.get(pipelineId);
  }

  function getByRunId(runId: string): PipelineEntry | undefined {
    for (const entry of entries.values()) {
      if (entry.runId === runId) return entry;
    }
    return undefined;
  }

  function list(): PipelineEntry[] {
    return Array.from(entries.values());
  }

  function isRunning(pipelineId: string): boolean {
    return entries.get(pipelineId)?.pipeline.isRunning() ?? false;
  }

  function remove(pipelineId: string): boolean {
    const entry = entries.get(pipelineId);
    if (!entry) return false;
    if (entry.pipeline.isRunning()) return false;
    overlayKeyIndex.delete(entry.overlayKey);
    entries.delete(pipelineId);
    return true;
  }

  function stopAll(reason = 'shutdown'): void {
    for (const entry of entries.values()) {
      if (entry.pipeline.isRunning()) {
        try { entry.pipeline.stop(reason); } catch { /* noop */ }
      }
    }
  }

  function size(): number {
    return entries.size;
  }

  return {
    start,
    stop,
    get,
    getByOverlayKey,
    getByRunId,
    list,
    isRunning,
    remove,
    stopAll,
    size,
  };
}
