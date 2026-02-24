import { randomUUID } from 'node:crypto';

function buildTakumiPayload(claim) {
  return {
    schemaVersion: '1.0',
    templateVersion: 'fc-lower-third-v1',
    fields: {
      claim: (claim.claim ?? '').slice(0, 484),
      correctedClaim: claim.correctedClaim ? claim.correctedClaim.slice(0, 484) : null,
      verdict: claim.verdict ?? 'unverified',
      confidence: claim.confidence ?? null,
      summary: (claim.summary ?? '').slice(0, 484),
      timecode: claim.chunkStartClock ?? null,
      sources: (claim.sources ?? []).map((source) => ({
        publisher: source.publisher ?? 'Unknown',
        title: source.title ?? null,
        url: source.url ?? null,
        textualRating: source.textualRating ?? null,
        reviewDate: source.reviewDate ?? null
      })),
      economicEvidence: {
        state: claim.fredEvidenceState ?? 'not_applicable',
        summary: claim.fredEvidenceSummary ?? null,
        sources: claim.fredEvidenceSources ?? []
      }
    }
  };
}

export function createOutputPackageService(options = {}) {
  const packagesByClaim = new Map();
  let onEvent = options.onEvent;

  function normalizeClaimVersion(claim) {
    const parsed = Number.parseInt(String(claim?.version ?? ''), 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }

    return null;
  }

  function emit(type, payload = {}) {
    onEvent?.({
      type,
      at: new Date().toISOString(),
      ...payload
    });
  }

  function toReadyPackage(basePackage, claim) {
    const payload = buildTakumiPayload(claim);
    return {
      ...basePackage,
      status: 'ready',
      payload,
      updatedAt: new Date().toISOString()
    };
  }

  async function queueForClaim(claim, context = {}) {
    const now = new Date().toISOString();
    const claimVersion = normalizeClaimVersion(claim);
    const previous = packagesByClaim.get(claim.claimId);
    const reusePackageId = previous && previous.claimVersion === claimVersion;
    const queued = {
      packageId: reusePackageId ? previous.packageId : randomUUID(),
      claimId: claim.claimId,
      runId: context.runId ?? claim.runId ?? null,
      claimVersion,
      status: 'queued',
      error: null,
      templateVersion: 'fc-lower-third-v1',
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      payload: reusePackageId ? previous.payload ?? null : null
    };

    packagesByClaim.set(claim.claimId, queued);
    emit('claim.output_package_queued', {
      claimId: claim.claimId,
      packageId: queued.packageId,
      runId: queued.runId,
      claimVersion: queued.claimVersion,
      outputPackageStatus: 'queued'
    });

    try {
      const ready = toReadyPackage(queued, claim);
      packagesByClaim.set(claim.claimId, ready);
      emit('claim.output_package_ready', {
        claimId: claim.claimId,
        packageId: ready.packageId,
        runId: ready.runId,
        claimVersion: ready.claimVersion,
        outputPackageStatus: 'ready'
      });
      return ready;
    } catch (error) {
      const failed = {
        ...queued,
        status: 'failed',
        error: error.message,
        updatedAt: new Date().toISOString()
      };
      packagesByClaim.set(claim.claimId, failed);
      emit('claim.output_package_failed', {
        claimId: claim.claimId,
        packageId: failed.packageId,
        runId: failed.runId,
        claimVersion: failed.claimVersion,
        error: failed.error,
        outputPackageStatus: 'failed'
      });
      return failed;
    }
  }

  function getByClaimId(claimId) {
    return packagesByClaim.get(claimId) ?? null;
  }

  function listByRunId(runId) {
    return Array.from(packagesByClaim.values())
      .filter((entry) => !runId || entry.runId === runId)
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }

  function clear() {
    packagesByClaim.clear();
  }

  function setEventHandler(handler) {
    onEvent = handler;
  }

  return {
    queueForClaim,
    getByClaimId,
    listByRunId,
    clear,
    setEventHandler
  };
}
