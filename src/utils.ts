export function parsePositiveInt(value: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, max);
}

export function parseNonNegativeInt(value: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.min(parsed, max);
}

export function clockTime(totalSeconds: number): string {
  const clamped = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(clamped / 3600).toString().padStart(2, '0');
  const minutes = Math.floor((clamped % 3600) / 60).toString().padStart(2, '0');
  const seconds = (clamped % 60).toString().padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

export function compactWhitespace(value: unknown): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Shared verdict normalization (A1) ──────────────────────────────────────

import type { Verdict, PipelineEvent } from './types.js';

export function normalizeVerdict(textualRating: string = ''): Verdict {
  const rating = compactWhitespace(textualRating).toLowerCase();
  if (!rating) return 'unverified';

  if (
    rating.includes('pants on fire') || rating.includes('not true') ||
    rating.includes('debunked') || rating.includes('no evidence') ||
    rating.includes('fake') || rating.includes('hoax') ||
    rating.includes('fabricated') || rating.includes('bogus') ||
    rating.includes('incorrect') || rating.includes('false')
  ) return 'false';

  if (
    rating.includes('misleading') || rating.includes('mostly false') ||
    rating.includes('partly false') || rating.includes('half true') ||
    rating.includes('mixed') || rating.includes('out of context') ||
    rating.includes('missing context') || rating.includes('needs context') ||
    rating.includes('partly true')
  ) return 'misleading';

  if (
    rating.includes('mostly true') || rating.includes('true') ||
    rating.includes('correct') || rating.includes('accurate') ||
    rating.includes('authentic')
  ) return 'true';

  return 'unverified';
}

// ── Shared claim version normalization (A5) ────────────────────────────────

export function normalizeClaimVersion(version: unknown): number {
  const parsed = Number.parseInt(String(version ?? 1), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

// ── Shared event emitter helper (A6) ───────────────────────────────────────

export function createEmitter(onEvent: ((event: PipelineEvent) => void) | undefined) {
  return function emit(type: string, payload: Record<string, unknown> = {}): void {
    onEvent?.({ type, at: new Date().toISOString(), ...payload } as PipelineEvent);
  };
}
