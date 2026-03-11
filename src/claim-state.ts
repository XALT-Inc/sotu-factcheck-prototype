import type { Claim } from './types.js';

const DEFAULT_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const CLEANUP_INTERVAL_MS = 60 * 1000; // 1 minute

const claims = new Map<string, Claim>();
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

export function mutateClaim(
  claimId: string,
  expectedVersion: number | null,
  updater: (claim: Claim) => Partial<Claim>
): Claim {
  const existing = claims.get(claimId);

  if (existing && expectedVersion !== null && expectedVersion !== existing.version) {
    throw new VersionConflictError(claimId, expectedVersion, existing.version);
  }

  if (!existing) {
    throw new ClaimNotFoundError(claimId);
  }

  const updates = updater(existing);
  const updated: Claim = {
    ...existing,
    ...updates,
    version: (existing.version ?? 1) + 1,
    updatedAt: new Date().toISOString(),
  };

  claims.set(claimId, updated);
  return updated;
}

export function setClaim(claimId: string, claim: Claim): void {
  claims.set(claimId, claim);
}

export function getClaim(claimId: string): Claim | undefined {
  return claims.get(claimId);
}

export function getAllClaims(): Claim[] {
  return Array.from(claims.values());
}

export function getClaimsForRun(runId: string): Claim[] {
  return Array.from(claims.values()).filter((c) => c.runId === runId);
}

export function getClaimsSorted(): Claim[] {
  return Array.from(claims.values()).sort((a, b) =>
    (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')
  );
}

export function clearClaims(): void {
  claims.clear();
}

export function claimCount(): number {
  return claims.size;
}

export function startCleanupInterval(maxAgeMs: number = DEFAULT_TTL_MS): void {
  stopCleanupInterval();
  cleanupTimer = setInterval(() => {
    evictStale(maxAgeMs);
  }, CLEANUP_INTERVAL_MS);

  if (typeof cleanupTimer.unref === 'function') {
    cleanupTimer.unref();
  }
}

export function stopCleanupInterval(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

function evictStale(maxAgeMs: number): void {
  const cutoff = Date.now() - maxAgeMs;
  for (const [id, claim] of claims) {
    const updatedAt = claim.updatedAt ? new Date(claim.updatedAt).getTime() : 0;
    if (updatedAt < cutoff) {
      claims.delete(id);
    }
  }
}

export class VersionConflictError extends Error {
  public readonly claimId: string;
  public readonly expectedVersion: number;
  public readonly currentVersion: number;

  constructor(claimId: string, expected: number, current: number) {
    super(`Claim state changed. Expected version=${expected}, current=${current}.`);
    this.name = 'VersionConflictError';
    this.claimId = claimId;
    this.expectedVersion = expected;
    this.currentVersion = current;
  }
}

export class ClaimNotFoundError extends Error {
  public readonly claimId: string;

  constructor(claimId: string) {
    super(`Claim not found: ${claimId}`);
    this.name = 'ClaimNotFoundError';
    this.claimId = claimId;
  }
}
