import * as claimState from '../claim-state.js';
import { evaluateClaimPolicy } from '../policy-engine.js';
import { EVENT_HISTORY_MAX, FRED_NOT_APPLICABLE_SUMMARY, FRED_AWAITING_SUMMARY, CONGRESS_NOT_APPLICABLE_SUMMARY, CONGRESS_AWAITING_SUMMARY } from '../constants.js';
import type { Claim, PipelineEvent, PolicyEvaluation, ActivityStore } from '../types.js';
import type { PipelineRegistry } from '../pipeline-registry.js';
import type { SseManager } from './sse.js';

export interface ClaimEventContext {
  pipelineRegistry: PipelineRegistry;
  activityStore: ActivityStore;
  sseManager: SseManager;
  eventHistory: PipelineEvent[];
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

function isClaimEventType(type: string): boolean { return type.startsWith('claim.'); }

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

export function buildClaimEventPayload(type: string, claim: Claim, extras: Record<string, unknown> = {}): Record<string, unknown> {
  return { type, runId: claim.runId, claimId: claim.claimId, ...claimSnapshotEventFields(claim), ...extras };
}

export function updateClaimState(event: PipelineEvent, ctx: ClaimEventContext): void {
  const e = event as Record<string, unknown>;

  if (e.type === 'claim.detected') {
    const row = withPolicy({
      claimId: e.claimId as string, runId: e.runId as string ?? null, claim: e.claim as string,
      status: e.status as string, verdict: (e.verdict ?? 'unverified') as Claim['verdict'],
      confidence: e.confidence as number, reasons: e.reasons as string[],
      claimCategory: (e.claimCategory ?? 'general') as Claim['claimCategory'],
      claimTypeTag: (e.claimTypeTag ?? 'other') as Claim['claimTypeTag'],
      claimTypeConfidence: (e.claimTypeConfidence ?? e.confidence ?? 0) as number,
      googleEvidenceState: 'none', fredEvidenceState: e.claimCategory === 'economic' ? 'ambiguous' : 'not_applicable',
      fredEvidenceSummary: e.claimCategory === 'economic' ? FRED_AWAITING_SUMMARY : FRED_NOT_APPLICABLE_SUMMARY,
      fredEvidenceSources: [], congressEvidenceState: (e.claimCategory === 'political' || e.claimCategory === 'legislative') ? 'ambiguous' : 'not_applicable',
      congressEvidenceSummary: (e.claimCategory === 'political' || e.claimCategory === 'legislative') ? CONGRESS_AWAITING_SUMMARY : CONGRESS_NOT_APPLICABLE_SUMMARY,
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
      ...existing, runId: (e.runId as string) ?? existing.runId ?? ctx.getCurrentRunId() ?? null,
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

export function createEmitEvent(ctx: ClaimEventContext): (event: PipelineEvent) => void {
  return function emitEvent(event: PipelineEvent): void {
    const seq = ctx.getEventSeq();
    let enriched: PipelineEvent = { seq, ...event };
    const e = enriched as Record<string, unknown>;

    if (e.type === 'pipeline.started') { ctx.setCurrentRunId((e.runId as string) ?? null); ctx.eventHistory.length = 0; }
    updateClaimState(enriched, ctx);

    if (e.type === 'pipeline.started') {
      ctx.activityStore.enqueueRunStart({ runId: e.runId ?? null, youtubeUrl: e.youtubeUrl ?? null, chunkSeconds: e.chunkSeconds ?? null, model: e.model ?? null, startedAt: e.at });
    } else if (e.type === 'pipeline.stopped') {
      ctx.activityStore.enqueueRunStop({ runId: e.runId ?? ctx.getCurrentRunId() ?? null, reason: e.reason ?? null, stoppedAt: e.at });
    }

    if (isClaimEventType(e.type as string) && e.claimId) {
      const snapshot = claimState.getClaim(e.claimId as string);
      if (snapshot) { enriched = { ...enriched, ...claimSnapshotEventFields(snapshot) }; ctx.activityStore.enqueueClaimSnapshot(snapshot as unknown as Record<string, unknown>); }
    }

    ctx.eventHistory.push(enriched);
    if (ctx.eventHistory.length > EVENT_HISTORY_MAX) ctx.eventHistory.shift();
    ctx.activityStore.enqueueEvent(enriched);

    if (e.type === 'pipeline.stopped') {
      const stoppedRunId = e.runId as string | undefined;
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
