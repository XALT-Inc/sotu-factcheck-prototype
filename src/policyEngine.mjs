const TAG_THRESHOLDS = {
  numeric_factual: 0.6,
  simple_policy: 0.75,
  other: 0.8
};

function normalizeTag(tag) {
  if (tag === 'numeric_factual' || tag === 'simple_policy' || tag === 'other') {
    return tag;
  }

  return 'other';
}

function ratingBucket(text = '') {
  const rating = String(text).toLowerCase();
  if (!rating) {
    return 'unverified';
  }

  if (rating.includes('false') || rating.includes('incorrect') || rating.includes('pants on fire')) {
    return 'false';
  }

  if (
    rating.includes('misleading') ||
    rating.includes('mixed') ||
    rating.includes('partly false') ||
    rating.includes('half true') ||
    rating.includes('mostly false')
  ) {
    return 'misleading';
  }

  if (rating.includes('true') || rating.includes('correct') || rating.includes('mostly true')) {
    return 'supported';
  }

  return 'unverified';
}

function countIndependentSources(sources = []) {
  const keys = new Set();
  for (const source of sources) {
    const publisher = String(source?.publisher ?? '').toLowerCase().trim();
    const url = String(source?.url ?? '').toLowerCase().trim();
    const key = publisher || url;
    if (key) {
      keys.add(key);
    }
  }

  return keys.size;
}

function hasConflictingEvidence(sources = []) {
  const verdicts = new Set();

  for (const source of sources) {
    const bucket = ratingBucket(source?.textualRating);
    if (bucket !== 'unverified') {
      verdicts.add(bucket);
    }
  }

  return verdicts.size > 1;
}

function evidenceStatusForClaim(claim, independentSourceCount, evidenceConflict) {
  const status = String(claim.status ?? '');
  if (status === 'pending_research' || status === 'researching') {
    return 'researching';
  }

  const googleState = String(claim.googleEvidenceState ?? 'none');
  if (googleState === 'error') {
    return 'provider_degraded';
  }

  if (claim.claimCategory === 'economic') {
    const fredState = String(claim.fredEvidenceState ?? 'not_applicable');
    if (fredState === 'error') {
      return 'provider_degraded';
    }
    if (fredState !== 'matched' && independentSourceCount < 1) {
      return 'insufficient';
    }
    // If FRED matched, that IS the authoritative source — no Google FC needed
  } else {
    // Non-economic: require at least 1 Google FC source
    if (independentSourceCount < 1) {
      return 'insufficient';
    }
  }

  if (evidenceConflict) {
    return 'conflicted';
  }

  return 'sufficient';
}

function reasonFromEvidenceStatus(status) {
  switch (status) {
    case 'researching':
      return 'still_researching';
    case 'provider_degraded':
      return 'provider_degraded';
    case 'insufficient':
      return 'insufficient_sources';
    case 'conflicted':
      return 'conflicted_sources';
    default:
      return null;
  }
}

export function evaluateClaimPolicy(claim) {
  const tag = normalizeTag(claim.claimTypeTag);
  const threshold = TAG_THRESHOLDS[tag];
  const confidence = Number(claim.confidence ?? 0);
  const sources = Array.isArray(claim.sources) ? claim.sources : [];
  const independentSourceCount = countIndependentSources(sources);
  const evidenceConflict = hasConflictingEvidence(sources);
  const evidenceStatus = evidenceStatusForClaim(claim, independentSourceCount, evidenceConflict);

  let approvalBlockReason = null;

  if (claim.outputApprovalState === 'rejected') {
    approvalBlockReason = 'rejected_locked';
  } else if (String(claim.status ?? '') !== 'researched') {
    approvalBlockReason =
      String(claim.status ?? '') === 'pending_research' || String(claim.status ?? '') === 'researching'
        ? 'still_researching'
        : 'not_researched';
  } else {
    approvalBlockReason = reasonFromEvidenceStatus(evidenceStatus);
  }

  if (!approvalBlockReason && confidence < threshold) {
    approvalBlockReason = 'below_threshold';
  }

  const approvalEligibility = approvalBlockReason === null;

  let exportBlockReason = approvalBlockReason;
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
    exportBlockReason
  };
}
