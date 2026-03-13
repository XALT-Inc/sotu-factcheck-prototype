import type { TakumiPayload, ClaimForOutput } from './types.js';
import type { ClaimRenderData } from './graphic-template.js';
import { CLAIM_TEXT_LIMIT, DEFAULT_SCHEMA_VERSION, DEFAULT_TEMPLATE_VERSION } from './constants.js';

export function buildTakumiPayload(claim: ClaimForOutput): TakumiPayload {
  return {
    schemaVersion: DEFAULT_SCHEMA_VERSION,
    templateVersion: DEFAULT_TEMPLATE_VERSION,
    fields: {
      claim: (claim.claim ?? '').slice(0, CLAIM_TEXT_LIMIT),
      correctedClaim: claim.correctedClaim ? claim.correctedClaim.slice(0, CLAIM_TEXT_LIMIT) : null,
      verdict: (claim.verdict ?? 'unverified') as TakumiPayload['fields']['verdict'],
      confidence: claim.confidence ?? null,
      summary: (claim.summary ?? '').slice(0, CLAIM_TEXT_LIMIT),
      timecode: claim.chunkStartClock ?? null,
      sources: (claim.sources ?? []).map((source) => ({
        publisher: source.publisher ?? 'Unknown',
        title: source.title ?? null,
        url: source.url ?? null,
        textualRating: source.textualRating ?? null,
        reviewDate: source.reviewDate ?? null,
      })),
      economicEvidence: {
        state: claim.fredEvidenceState ?? 'not_applicable',
        summary: claim.fredEvidenceSummary ?? null,
        sources: (claim.fredEvidenceSources ?? []) as TakumiPayload['fields']['economicEvidence']['sources'],
      },
    },
  };
}

export function claimToRenderData(claim: ClaimForOutput): ClaimRenderData {
  return {
    claim: String(claim.claim ?? '').slice(0, CLAIM_TEXT_LIMIT),
    correctedClaim: claim.correctedClaim ? String(claim.correctedClaim).slice(0, CLAIM_TEXT_LIMIT) : null,
    verdict: String(claim.verdict ?? 'unverified'),
    confidence: typeof claim.confidence === 'number' ? claim.confidence : null,
    summary: String(claim.summary ?? '').slice(0, CLAIM_TEXT_LIMIT),
    timecode: claim.chunkStartClock ?? null,
    sources: (claim.sources ?? []).slice(0, 3).map((s) => ({
      publisher: s.publisher ?? 'Unknown',
      textualRating: s.textualRating ?? null,
    })),
  };
}

export function buildDefaultRenderPayload(claim: ClaimForOutput): Record<string, unknown> {
  return {
    claim: (claim.claim ?? '').slice(0, CLAIM_TEXT_LIMIT),
    correctedClaim: claim.correctedClaim ? claim.correctedClaim.slice(0, CLAIM_TEXT_LIMIT) : null,
    verdict: claim.verdict ?? 'unverified',
    confidence: claim.confidence ?? null,
    summary: (claim.summary ?? '').slice(0, CLAIM_TEXT_LIMIT),
    timecode: claim.chunkStartClock ?? null,
    sources: (claim.sources ?? []).slice(0, 3).map((source) => ({
      publisher: source.publisher ?? 'Unknown',
      title: source.title ?? null,
      url: source.url ?? null,
      textualRating: source.textualRating ?? null,
    })),
  };
}
