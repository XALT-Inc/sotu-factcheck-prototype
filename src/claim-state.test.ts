import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  setClaim, getClaim, getAllClaims, getClaimsForRun, getClaimsSorted,
  clearClaims, claimCount, mutateClaim, startCleanupInterval, stopCleanupInterval,
  VersionConflictError, ClaimNotFoundError,
} from './claim-state.js';
import type { Claim } from './types.js';

function makeClaim(overrides: Partial<Claim> = {}): Claim {
  return {
    claimId: 'claim-1',
    runId: 'run-1',
    claim: 'Test claim text',
    status: 'researched',
    verdict: 'unverified',
    confidence: 0.5,
    summary: null,
    sources: [],
    chunkStartSec: 0,
    chunkStartClock: '0:00:00',
    claimCategory: 'general',
    claimTypeTag: 'other',
    claimTypeConfidence: 0.5,
    googleEvidenceState: 'none',
    fredEvidenceState: 'none',
    fredEvidenceSummary: null,
    fredEvidenceSources: [],
    congressEvidenceState: 'none',
    congressEvidenceSummary: null,
    congressEvidenceSources: [],
    correctedClaim: null,
    aiSummary: null,
    aiVerdict: null,
    aiConfidence: null,
    evidenceBasis: null,
    googleFcVerdict: null,
    googleFcConfidence: null,
    googleFcSummary: null,
    outputApprovalState: 'pending',
    outputPackageStatus: 'none',
    outputPackageId: null,
    outputPackageError: null,
    renderStatus: 'none',
    renderJobId: null,
    artifactUrl: null,
    renderError: null,
    approvedAt: null,
    approvedVersion: null,
    rejectedAt: null,
    detectedAt: null,
    updatedAt: new Date().toISOString(),
    version: 1,
    ...overrides,
  };
}

beforeEach(() => {
  clearClaims();
});

afterEach(() => {
  stopCleanupInterval();
  clearClaims();
});

describe('basic CRUD', () => {
  it('sets and gets a claim', () => {
    const claim = makeClaim();
    setClaim('claim-1', claim);
    expect(getClaim('claim-1')).toEqual(claim);
  });

  it('returns undefined for missing claim', () => {
    expect(getClaim('missing')).toBeUndefined();
  });

  it('counts claims', () => {
    setClaim('a', makeClaim({ claimId: 'a' }));
    setClaim('b', makeClaim({ claimId: 'b' }));
    expect(claimCount()).toBe(2);
  });

  it('clears all claims', () => {
    setClaim('a', makeClaim({ claimId: 'a' }));
    clearClaims();
    expect(claimCount()).toBe(0);
  });

  it('getAllClaims returns all claims', () => {
    setClaim('a', makeClaim({ claimId: 'a' }));
    setClaim('b', makeClaim({ claimId: 'b' }));
    expect(getAllClaims()).toHaveLength(2);
  });

  it('getClaimsForRun filters by runId', () => {
    setClaim('a', makeClaim({ claimId: 'a', runId: 'run-1' }));
    setClaim('b', makeClaim({ claimId: 'b', runId: 'run-2' }));
    setClaim('c', makeClaim({ claimId: 'c', runId: 'run-1' }));
    expect(getClaimsForRun('run-1')).toHaveLength(2);
    expect(getClaimsForRun('run-2')).toHaveLength(1);
  });

  it('getClaimsSorted returns claims sorted by updatedAt desc', () => {
    setClaim('a', makeClaim({ claimId: 'a', updatedAt: '2024-01-01T00:00:00Z' }));
    setClaim('b', makeClaim({ claimId: 'b', updatedAt: '2024-01-03T00:00:00Z' }));
    setClaim('c', makeClaim({ claimId: 'c', updatedAt: '2024-01-02T00:00:00Z' }));
    const sorted = getClaimsSorted();
    expect(sorted[0].claimId).toBe('b');
    expect(sorted[1].claimId).toBe('c');
    expect(sorted[2].claimId).toBe('a');
  });
});

describe('mutateClaim', () => {
  it('mutates a claim and increments version', () => {
    setClaim('claim-1', makeClaim({ version: 1 }));
    const updated = mutateClaim('claim-1', null, () => ({ verdict: 'false' }));
    expect(updated.verdict).toBe('false');
    expect(updated.version).toBe(2);
  });

  it('updates the updatedAt timestamp', () => {
    const oldDate = '2020-01-01T00:00:00Z';
    setClaim('claim-1', makeClaim({ updatedAt: oldDate }));
    const updated = mutateClaim('claim-1', null, () => ({ verdict: 'true' }));
    expect(updated.updatedAt).not.toBe(oldDate);
  });

  it('throws VersionConflictError on version mismatch', () => {
    setClaim('claim-1', makeClaim({ version: 3 }));
    expect(() => mutateClaim('claim-1', 2, () => ({}))).toThrow(VersionConflictError);
  });

  it('succeeds when expectedVersion matches', () => {
    setClaim('claim-1', makeClaim({ version: 3 }));
    const updated = mutateClaim('claim-1', 3, () => ({ verdict: 'true' }));
    expect(updated.verdict).toBe('true');
    expect(updated.version).toBe(4);
  });

  it('throws ClaimNotFoundError for missing claim', () => {
    expect(() => mutateClaim('missing', null, () => ({}))).toThrow(ClaimNotFoundError);
  });

  it('passes the existing claim to the updater', () => {
    setClaim('claim-1', makeClaim({ confidence: 0.7 }));
    mutateClaim('claim-1', null, (existing) => {
      expect(existing.confidence).toBe(0.7);
      return {};
    });
  });
});

describe('TTL cleanup', () => {
  it('evicts stale claims on interval', () => {
    vi.useFakeTimers();
    const staleDate = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(); // 5 hours ago
    const freshDate = new Date().toISOString();

    setClaim('stale', makeClaim({ claimId: 'stale', updatedAt: staleDate }));
    setClaim('fresh', makeClaim({ claimId: 'fresh', updatedAt: freshDate }));

    startCleanupInterval(4 * 60 * 60 * 1000); // 4 hour TTL

    vi.advanceTimersByTime(61_000); // advance past the 60s interval

    expect(getClaim('stale')).toBeUndefined();
    expect(getClaim('fresh')).toBeDefined();

    vi.useRealTimers();
  });
});
