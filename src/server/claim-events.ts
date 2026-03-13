import * as claimState from '../claim-state.js';
import { evaluateClaimPolicy } from '../policy-engine.js';
import { FRED_NOT_APPLICABLE_SUMMARY, FRED_AWAITING_SUMMARY, CONGRESS_NOT_APPLICABLE_SUMMARY, CONGRESS_AWAITING_SUMMARY } from '../constants.js';
import type { RingBuffer } from '../ring-buffer.js';
import { isClaimEvent } from '../types.js';
import type { Claim, PipelineEvent, PolicyEvaluation, ActivityStore } from '../types.js';
import type { PipelineRegistry } from '../pipeline-registry.js';
import type { SseManager } from './sse.js';

export interface ClaimEventContext {
  pipelineRegistry: PipelineRegistry;
  activityStore: ActivityStore;
  sseManager: SseManager;
  eventHistory: RingBuffer<PipelineEvent>;
  getEventSeq: () => number;
  getCurrentRunId: () => string | null;
  setCurrentRunId: (runId: string | null) => void;
  getDefaultPipelineId: () => string | null;
  setDefaultPipelineId: (id: string | null) => void;
  setCurrentOverlayKey: (key: string | null) => void;
  setCurrentYoutubeUrl: (url: string | null) => void;
  setCurrentStartedAt: (at: string | null) => void;
}

export function withPolicy(claim: Claim): Claim & PolicyEvaluation {
  return { ...claim, ...evaluateClaimPolicy(claim) };
}

function nextClaimVersion(claim: Claim): number {
  const parsed = Number.parseInt(String(claim?.version ?? 1), 10);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed + 1 : 1;
}

export { nextClaimVersion };

export function claimSnapshotEventFields(claim: Claim): Record<string, unknown> {
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

export function buildClaimEventPayload(type: string, claim: Claim, extras: Record<string, unknown> = {}): PipelineEvent {
  return { type, runId: claim.runId, claimId: claim.claimId, ...claimSnapshotEventFields(claim), ...extras } as PipelineEvent;
}

export function updateClaimState(event: PipelineEvent, ctx: ClaimEventContext): void {
  if (event.type === 'claim.detected') {
    const row = withPolicy({
      claimId: event.claimId, runId: event.runId ?? null, claim: event.claim,
      status: event.status, verdict: (event.verdict ?? 'unverified') as Claim['verdict'],
      confidence: event.confidence, reasons: event.reasons,
      claimCategory: (event.claimCategory ?? 'general') as Claim['claimCategory'],
      claimTypeTag: (event.claimTypeTag ?? 'other') as Claim['claimTypeTag'],
      claimTypeConfidence: (event.claimTypeConfidence ?? event.confidence ?? 0) as number,
      googleEvidenceState: 'none', fredEvidenceState: event.claimCategory === 'economic' ? 'ambiguous' : 'not_applicable',
      fredEvidenceSummary: event.claimCategory === 'economic' ? FRED_AWAITING_SUMMARY : FRED_NOT_APPLICABLE_SUMMARY,
      fredEvidenceSources: [], congressEvidenceState: (event.claimCategory === 'political' || event.claimCategory === 'legislative') ? 'ambiguous' : 'not_applicable',
      congressEvidenceSummary: (event.claimCategory === 'political' || event.claimCategory === 'legislative') ? CONGRESS_AWAITING_SUMMARY : CONGRESS_NOT_APPLICABLE_SUMMARY,
      congressEvidenceSources: [], correctedClaim: null, aiSummary: null, aiVerdict: null, aiConfidence: null, evidenceBasis: null,
      googleFcVerdict: null, googleFcConfidence: null, googleFcSummary: null,
      chunkStartSec: event.chunkStartSec, chunkStartClock: event.chunkStartClock,
      sources: [], summary: null, outputApprovalState: 'pending', outputPackageStatus: 'none',
      outputPackageId: null, outputPackageError: null, renderStatus: 'none', renderJobId: null,
      artifactUrl: null, renderError: null, approvedAt: null, approvedVersion: null, rejectedAt: null,
      detectedAt: event.at as string, updatedAt: event.at as string, version: 1,
    } as Claim);
    claimState.setClaim(event.claimId, row);
    return;
  }

  if (event.type === 'claim.researching') {
    const existing = claimState.getClaim(event.claimId);
    if (existing) claimState.setClaim(event.claimId, withPolicy({ ...existing, status: 'researching', updatedAt: event.at as string, version: (existing.version ?? 1) + 1 }));
    return;
  }

  if (event.type === 'claim.updated') {
    const existing = claimState.getClaim(event.claimId) ?? { claimId: event.claimId, claim: event.claim, detectedAt: event.at } as Claim;
    const wasApproved = existing.outputApprovalState === 'approved';
    const nextApprovalState = wasApproved ? 'pending' : existing.outputApprovalState ?? 'pending';
    const reset = wasApproved;
    claimState.setClaim(event.claimId, withPolicy({
      ...existing, runId: event.runId ?? existing.runId ?? ctx.getCurrentRunId() ?? null,
      status: event.status, verdict: event.verdict as Claim['verdict'], confidence: event.confidence,
      summary: (event.summary ?? null) as string | null, sources: (event.sources ?? []) as Claim['sources'],
      requiresProducerApproval: event.requiresProducerApproval,
      claimCategory: (event.claimCategory ?? existing.claimCategory ?? 'general') as Claim['claimCategory'],
      claimTypeTag: (event.claimTypeTag ?? existing.claimTypeTag ?? 'other') as Claim['claimTypeTag'],
      claimTypeConfidence: (event.claimTypeConfidence ?? existing.claimTypeConfidence ?? event.confidence ?? 0) as number,
      googleEvidenceState: (event.googleEvidenceState ?? existing.googleEvidenceState ?? 'none') as Claim['googleEvidenceState'],
      fredEvidenceState: (event.fredEvidenceState ?? existing.fredEvidenceState ?? 'not_applicable') as Claim['fredEvidenceState'],
      fredEvidenceSummary: (event.fredEvidenceSummary ?? existing.fredEvidenceSummary ?? null) as string | null,
      fredEvidenceSources: (event.fredEvidenceSources ?? existing.fredEvidenceSources ?? []) as Claim['fredEvidenceSources'],
      congressEvidenceState: (event.congressEvidenceState ?? existing.congressEvidenceState ?? 'not_applicable') as Claim['congressEvidenceState'],
      congressEvidenceSummary: (event.congressEvidenceSummary ?? existing.congressEvidenceSummary ?? null) as string | null,
      congressEvidenceSources: (event.congressEvidenceSources ?? existing.congressEvidenceSources ?? []) as Claim['congressEvidenceSources'],
      correctedClaim: (event.correctedClaim ?? existing.correctedClaim ?? null) as string | null,
      aiSummary: (event.aiSummary ?? existing.aiSummary ?? null) as string | null,
      aiVerdict: (event.aiVerdict ?? existing.aiVerdict ?? null) as Claim['aiVerdict'],
      aiConfidence: (event.aiConfidence ?? existing.aiConfidence ?? null) as number | null,
      evidenceBasis: (event.evidenceBasis ?? existing.evidenceBasis ?? null) as Claim['evidenceBasis'],
      googleFcVerdict: (event.googleFcVerdict ?? existing.googleFcVerdict ?? null) as Claim['googleFcVerdict'],
      googleFcConfidence: (event.googleFcConfidence ?? existing.googleFcConfidence ?? null) as number | null,
      googleFcSummary: (event.googleFcSummary ?? existing.googleFcSummary ?? null) as string | null,
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
      updatedAt: event.at as string, version: (existing.version ?? 1) + 1,
    } as Claim));
    return;
  }

  // Remaining claim events require existing claim state
  if (!isClaimEvent(event)) return;
  const claimId = event.claimId;
  if (!claimId) return;
  const existing = claimState.getClaim(claimId);
  if (!existing) return;

  if (event.type === 'claim.output_approved') {
    claimState.setClaim(claimId, withPolicy({ ...existing, outputApprovalState: 'approved', approvedAt: (event.approvedAt ?? event.at) as string, approvedVersion: (event.approvedVersion ?? nextClaimVersion(existing)) as number, rejectedAt: null, updatedAt: event.at as string, version: (existing.version ?? 1) + 1 }));
  } else if (event.type === 'claim.output_rejected') {
    claimState.setClaim(claimId, withPolicy({ ...existing, outputApprovalState: 'rejected', approvedAt: null, approvedVersion: null, rejectedAt: (event.rejectedAt ?? event.at) as string, updatedAt: event.at as string, version: (existing.version ?? 1) + 1 }));
  } else if (event.type === 'claim.output_package_queued' || event.type === 'claim.output_package_ready' || event.type === 'claim.output_package_failed') {
    if (existing.outputApprovalState !== 'approved') return;
    if (Number.isInteger(event.claimVersion) && Number.isInteger(existing.approvedVersion) && event.claimVersion !== existing.approvedVersion) return;
    const status = event.type === 'claim.output_package_queued' ? 'queued' : event.type === 'claim.output_package_ready' ? 'ready' : 'failed';
    claimState.setClaim(claimId, withPolicy({ ...existing, outputPackageStatus: status as Claim['outputPackageStatus'], outputPackageId: (event.packageId ?? existing.outputPackageId ?? null) as string | null, outputPackageError: status === 'failed' ? ((event.error ?? 'Package generation failed') as string) : null, updatedAt: event.at as string, version: (existing.version ?? 1) + 1 }));
  } else if (event.type === 'claim.render_queued' || event.type === 'claim.render_ready' || event.type === 'claim.render_failed') {
    if (existing.outputApprovalState !== 'approved') return;
    if (Number.isInteger(event.claimVersion) && Number.isInteger(existing.approvedVersion) && event.claimVersion !== existing.approvedVersion) return;
    if ((event.type === 'claim.render_ready' || event.type === 'claim.render_failed') && existing.renderJobId && event.renderJobId && existing.renderJobId !== event.renderJobId) return;
    const status = event.type === 'claim.render_queued' ? 'queued' : event.type === 'claim.render_ready' ? 'ready' : 'failed';
    claimState.setClaim(claimId, withPolicy({
      ...existing, renderStatus: status as Claim['renderStatus'],
      renderJobId: (event.renderJobId ?? existing.renderJobId ?? null) as string | null,
      artifactUrl: status === 'ready' ? ((event.artifactUrl ?? existing.artifactUrl ?? null) as string | null) : existing.artifactUrl,
      renderError: status === 'failed' ? ((event.error ?? 'Render job failed') as string) : null,
      updatedAt: event.at as string, version: (existing.version ?? 1) + 1,
    }));
  }
}

export function createEmitEvent(ctx: ClaimEventContext): (event: PipelineEvent) => void {
  return function emitEvent(event: PipelineEvent): void {
    const seq = ctx.getEventSeq();
    let enriched: PipelineEvent = { seq, ...event };

    if (enriched.type === 'pipeline.started') { ctx.setCurrentRunId(enriched.runId ?? null); ctx.eventHistory.clear(); }
    updateClaimState(enriched, ctx);

    if (enriched.type === 'pipeline.started') {
      ctx.activityStore.enqueueRunStart({ runId: enriched.runId ?? null, youtubeUrl: enriched.youtubeUrl ?? null, chunkSeconds: enriched.chunkSeconds ?? null, model: enriched.model ?? null, startedAt: enriched.at });
    } else if (enriched.type === 'pipeline.stopped') {
      ctx.activityStore.enqueueRunStop({ runId: enriched.runId ?? ctx.getCurrentRunId() ?? null, reason: enriched.reason ?? null, stoppedAt: enriched.at });
    }

    if (isClaimEvent(enriched) && enriched.claimId) {
      const snapshot = claimState.getClaim(enriched.claimId);
      if (snapshot) { enriched = { ...enriched, ...claimSnapshotEventFields(snapshot) } as PipelineEvent; ctx.activityStore.enqueueClaimSnapshot(snapshot as unknown as Record<string, unknown>); }
    }

    ctx.eventHistory.push(enriched);
    ctx.activityStore.enqueueEvent(enriched);

    if (enriched.type === 'pipeline.stopped') {
      const stoppedRunId = enriched.runId;
      const stoppedEntry = stoppedRunId ? ctx.pipelineRegistry.getByRunId(stoppedRunId) : null;
      if (stoppedEntry) {
        ctx.pipelineRegistry.remove(stoppedEntry.pipelineId);
      }
      if (!stoppedRunId || stoppedRunId === ctx.getCurrentRunId()) {
        if (ctx.getDefaultPipelineId() && stoppedEntry?.pipelineId === ctx.getDefaultPipelineId()) {
          ctx.setDefaultPipelineId(null);
        }
        ctx.setCurrentRunId(null);
        ctx.setCurrentOverlayKey(null);
        ctx.setCurrentYoutubeUrl(null);
        ctx.setCurrentStartedAt(null);
      }
    }

    ctx.sseManager.broadcast(enriched);
  };
}

export function policyBlockMessage(reason: string, claim: Claim): string {
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
