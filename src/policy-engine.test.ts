import { describe, it, expect } from 'vitest';
import { evaluateClaimPolicy } from './policy-engine.js';

function makeClaim(overrides: Record<string, unknown> = {}) {
  return {
    status: 'researched',
    googleEvidenceState: 'matched',
    claimTypeTag: 'numeric_factual',
    claimTypeConfidence: 0.8,
    confidence: 0.75,
    sources: [
      { publisher: 'PolitiFact', url: 'https://example.com/1', textualRating: 'False' },
    ],
    outputApprovalState: 'pending',
    ...overrides,
  };
}

describe('evaluateClaimPolicy', () => {
  it('approves a well-researched numeric_factual claim above threshold', () => {
    const result = evaluateClaimPolicy(makeClaim());
    expect(result.approvalEligibility).toBe(true);
    expect(result.approvalBlockReason).toBeNull();
    expect(result.policyThreshold).toBe(0.6);
  });

  it('blocks approval for claims below threshold', () => {
    const result = evaluateClaimPolicy(makeClaim({ confidence: 0.3 }));
    expect(result.approvalEligibility).toBe(false);
    expect(result.approvalBlockReason).toBe('below_threshold');
  });

  it('blocks approval for rejected claims', () => {
    const result = evaluateClaimPolicy(makeClaim({ outputApprovalState: 'rejected' }));
    expect(result.approvalEligibility).toBe(false);
    expect(result.approvalBlockReason).toBe('rejected_locked');
  });

  it('blocks approval while still researching', () => {
    const result = evaluateClaimPolicy(makeClaim({ status: 'researching' }));
    expect(result.approvalEligibility).toBe(false);
    expect(result.approvalBlockReason).toBe('still_researching');
  });

  it('blocks approval for pending_research status', () => {
    const result = evaluateClaimPolicy(makeClaim({ status: 'pending_research' }));
    expect(result.approvalEligibility).toBe(false);
    expect(result.approvalBlockReason).toBe('still_researching');
  });

  it('blocks approval for non-researched status', () => {
    const result = evaluateClaimPolicy(makeClaim({ status: 'unknown' }));
    expect(result.approvalEligibility).toBe(false);
    expect(result.approvalBlockReason).toBe('not_researched');
  });

  it('uses higher threshold for simple_policy', () => {
    const result = evaluateClaimPolicy(makeClaim({ claimTypeTag: 'simple_policy', confidence: 0.7 }));
    expect(result.policyThreshold).toBe(0.75);
    expect(result.approvalEligibility).toBe(false);
    expect(result.approvalBlockReason).toBe('below_threshold');
  });

  it('uses highest threshold for other type', () => {
    const result = evaluateClaimPolicy(makeClaim({ claimTypeTag: 'other', confidence: 0.75 }));
    expect(result.policyThreshold).toBe(0.8);
    expect(result.approvalEligibility).toBe(false);
  });

  it('normalizes unknown tags to other', () => {
    const result = evaluateClaimPolicy(makeClaim({ claimTypeTag: 'made_up_tag' }));
    expect(result.claimTypeTag).toBe('other');
    expect(result.policyThreshold).toBe(0.8);
  });

  it('blocks export when not approved', () => {
    const result = evaluateClaimPolicy(makeClaim({ outputApprovalState: 'pending' }));
    expect(result.exportEligibility).toBe(false);
    expect(result.exportBlockReason).toBe('not_approved');
  });

  it('allows export when approved and eligible', () => {
    const result = evaluateClaimPolicy(makeClaim({ outputApprovalState: 'approved' }));
    expect(result.exportEligibility).toBe(true);
    expect(result.exportBlockReason).toBeNull();
  });

  it('detects conflicting evidence', () => {
    const sources = [
      { publisher: 'PolitiFact', textualRating: 'False' },
      { publisher: 'Snopes', textualRating: 'True' },
    ];
    const result = evaluateClaimPolicy(makeClaim({ sources }));
    expect(result.evidenceConflict).toBe(true);
  });

  it('counts independent sources by unique publisher', () => {
    const sources = [
      { publisher: 'PolitiFact', url: 'https://a.com', textualRating: 'False' },
      { publisher: 'Snopes', url: 'https://b.com', textualRating: 'False' },
      { publisher: 'PolitiFact', url: 'https://c.com', textualRating: 'False' },
    ];
    const result = evaluateClaimPolicy(makeClaim({ sources }));
    expect(result.independentSourceCount).toBe(2);
  });

  it('detects insufficient sources for economic claims without FRED', () => {
    const result = evaluateClaimPolicy(makeClaim({
      claimCategory: 'economic',
      fredEvidenceState: 'not_applicable',
      sources: [],
    }));
    expect(result.evidenceStatus).toBe('insufficient');
  });

  it('detects provider degradation on google error', () => {
    const result = evaluateClaimPolicy(makeClaim({
      googleEvidenceState: 'error',
    }));
    expect(result.evidenceStatus).toBe('provider_degraded');
  });
});
