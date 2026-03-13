import type { ClaimTypeTag, PolicyEvaluation, ApprovalBlockReason, ExportBlockReason } from './types.js';
import { normalizeVerdict } from './utils.js';

const TAG_THRESHOLDS: Record<ClaimTypeTag, number> = {
  numeric_factual: 0.6,
  simple_policy: 0.75,
  other: 0.8,
};

function normalizeTag(tag: unknown): ClaimTypeTag {
  if (tag === 'numeric_factual' || tag === 'simple_policy' || tag === 'other') {
    return tag;
  }
  return 'other';
}

interface SourceLike {
  publisher?: string;
  url?: string | null;
  textualRating?: string;
}

function countIndependentSources(sources: SourceLike[] = []): number {
  const keys = new Set<string>();
  for (const source of sources) {
    const publisher = String(source?.publisher ?? '').toLowerCase().trim();
    const url = String(source?.url ?? '').toLowerCase().trim();
    const key = publisher || url;
    if (key) keys.add(key);
  }
  return keys.size;
}

function hasConflictingEvidence(sources: SourceLike[] = []): boolean {
  const verdicts = new Set<string>();
  for (const source of sources) {
    const bucket = normalizeVerdict(String(source?.textualRating ?? ''));
    if (bucket !== 'unverified') verdicts.add(bucket);
  }
  return verdicts.size > 1;
}

interface ClaimLike {
  status?: string;
  googleEvidenceState?: string;
  fredEvidenceState?: string;
  congressEvidenceState?: string;
  claimCategory?: string;
  claimTypeTag?: string;
  claimTypeConfidence?: number;
  confidence?: number;
  sources?: SourceLike[];
  outputApprovalState?: string;
}

function evidenceStatusForClaim(
  claim: ClaimLike,
  independentSourceCount: number,
  evidenceConflict: boolean
): string {
  const status = String(claim.status ?? '');
  if (status === 'pending_research' || status === 'researching') return 'researching';

  const googleState = String(claim.googleEvidenceState ?? 'none');
  if (googleState === 'error') return 'provider_degraded';

  if (claim.claimCategory === 'economic') {
    const fredState = String(claim.fredEvidenceState ?? 'not_applicable');
    if (fredState === 'error') return 'provider_degraded';
    if (fredState !== 'matched' && independentSourceCount < 1) return 'insufficient';
  } else if (claim.claimCategory === 'political' || claim.claimCategory === 'legislative') {
    const congressState = String(claim.congressEvidenceState ?? 'not_applicable');
    if (congressState === 'error') return 'provider_degraded';
    if (congressState !== 'matched' && independentSourceCount < 1) return 'insufficient';
  } else {
    if (independentSourceCount < 1) return 'insufficient';
  }

  if (evidenceConflict) return 'conflicted';
  return 'sufficient';
}

function reasonFromEvidenceStatus(status: string): ApprovalBlockReason {
  switch (status) {
    case 'researching': return 'still_researching';
    case 'provider_degraded': return 'provider_degraded';
    case 'insufficient': return 'insufficient_sources';
    case 'conflicted': return 'conflicted_sources';
    default: return null;
  }
}

export function evaluateClaimPolicy(claim: ClaimLike): PolicyEvaluation {
  const tag = normalizeTag(claim.claimTypeTag);
  const threshold = TAG_THRESHOLDS[tag];
  const confidence = Number(claim.confidence ?? 0);
  const sources = Array.isArray(claim.sources) ? claim.sources : [];
  const independentSourceCount = countIndependentSources(sources);
  const evidenceConflict = hasConflictingEvidence(sources);
  const evidenceStatus = evidenceStatusForClaim(claim, independentSourceCount, evidenceConflict);

  let approvalBlockReason: ApprovalBlockReason = null;

  if (claim.outputApprovalState === 'rejected') {
    approvalBlockReason = 'rejected_locked';
  } else if (String(claim.status ?? '') !== 'researched') {
    const s = String(claim.status ?? '');
    approvalBlockReason =
      s === 'pending_research' || s === 'researching' ? 'still_researching' : 'not_researched';
  } else {
    approvalBlockReason = reasonFromEvidenceStatus(evidenceStatus);
  }

  if (!approvalBlockReason && confidence < threshold) {
    approvalBlockReason = 'below_threshold';
  }

  const approvalEligibility = approvalBlockReason === null;

  let exportBlockReason: ExportBlockReason = approvalBlockReason;
  if (!exportBlockReason && claim.outputApprovalState !== 'approved') {
    exportBlockReason = 'not_approved';
  }

  const exportEligibility = exportBlockReason === null;

  return {
    claimTypeTag: tag,
    claimTypeConfidence: Number((claim.claimTypeConfidence ?? confidence).toFixed(2)),
    policyThreshold: threshold,
    independentSourceCount,
    evidenceConflict,
    evidenceStatus,
    approvalEligibility,
    approvalBlockReason,
    exportEligibility,
    exportBlockReason,
  };
}
