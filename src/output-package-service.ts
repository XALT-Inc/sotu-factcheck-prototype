import { randomUUID } from 'node:crypto';
import type { OutputPackage, PipelineEvent, ClaimForOutput } from './types.js';
import { normalizeClaimVersion, createEmitter } from './utils.js';
import { buildTakumiPayload } from './claim-payload.js';
import { DEFAULT_TEMPLATE_VERSION } from './constants.js';

export interface OutputPackageServiceOptions {
  onEvent?: (event: PipelineEvent) => void;
}

export interface OutputPackageService {
  queueForClaim: (claim: ClaimForOutput, context?: { runId?: string | null }) => Promise<OutputPackage>;
  getByClaimId: (claimId: string) => OutputPackage | null;
  listByRunId: (runId?: string | null) => OutputPackage[];
  clear: () => void;
  setEventHandler: (handler: (event: PipelineEvent) => void) => void;
}

export function createOutputPackageService(options: OutputPackageServiceOptions = {}): OutputPackageService {
  const packagesByClaim = new Map<string, OutputPackage>();
  let onEvent = options.onEvent;
  let emit = createEmitter(onEvent);

  function toReadyPackage(basePackage: OutputPackage, claim: ClaimForOutput): OutputPackage {
    const payload = buildTakumiPayload(claim);
    return { ...basePackage, status: 'ready', payload, updatedAt: new Date().toISOString() };
  }

  async function queueForClaim(claim: ClaimForOutput, context: { runId?: string | null } = {}): Promise<OutputPackage> {
    const now = new Date().toISOString();
    const claimVersion = normalizeClaimVersion(claim.version) > 0 ? normalizeClaimVersion(claim.version) : null;
    const previous = packagesByClaim.get(claim.claimId);
    const reusePackageId = previous && previous.claimVersion === claimVersion;
    const queued: OutputPackage = {
      packageId: reusePackageId ? previous.packageId : randomUUID(),
      claimId: claim.claimId,
      runId: context.runId ?? claim.runId ?? null,
      claimVersion,
      status: 'queued',
      error: null,
      templateVersion: DEFAULT_TEMPLATE_VERSION,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      payload: reusePackageId ? previous.payload ?? null : null,
    };

    packagesByClaim.set(claim.claimId, queued);
    emit('claim.output_package_queued', {
      claimId: claim.claimId,
      packageId: queued.packageId,
      runId: queued.runId,
      claimVersion: queued.claimVersion,
      outputPackageStatus: 'queued',
    });

    try {
      const ready = toReadyPackage(queued, claim);
      packagesByClaim.set(claim.claimId, ready);
      emit('claim.output_package_ready', {
        claimId: claim.claimId,
        packageId: ready.packageId,
        runId: ready.runId,
        claimVersion: ready.claimVersion,
        outputPackageStatus: 'ready',
      });
      return ready;
    } catch (error) {
      const failed: OutputPackage = {
        ...queued,
        status: 'failed',
        error: (error as Error).message,
        updatedAt: new Date().toISOString(),
      };
      packagesByClaim.set(claim.claimId, failed);
      emit('claim.output_package_failed', {
        claimId: claim.claimId,
        packageId: failed.packageId,
        runId: failed.runId,
        claimVersion: failed.claimVersion,
        error: failed.error,
        outputPackageStatus: 'failed',
      });
      return failed;
    }
  }

  function getByClaimId(claimId: string): OutputPackage | null {
    return packagesByClaim.get(claimId) ?? null;
  }

  function listByRunId(runId?: string | null): OutputPackage[] {
    return Array.from(packagesByClaim.values())
      .filter((entry) => !runId || entry.runId === runId)
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }

  function clear(): void {
    packagesByClaim.clear();
  }

  function setEventHandler(handler: (event: PipelineEvent) => void): void {
    onEvent = handler;
    emit = createEmitter(onEvent);
  }

  return { queueForClaim, getByClaimId, listByRunId, clear, setEventHandler };
}
