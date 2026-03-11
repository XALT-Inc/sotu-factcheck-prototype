import type { Verdict, EvidenceBasis, VerificationResult, VerificationEvidence } from './types.js';
import { createLogger } from './logger.js';

const log = createLogger('gemini-verifier');

const SAFE_FALLBACK: VerificationResult = {
  aiVerdict: 'unverified',
  aiConfidence: 0,
  correctedClaim: null,
  aiSummary: null,
  evidenceBasis: null,
};

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    aiVerdict: { type: 'STRING', enum: ['true', 'false', 'misleading', 'unverified'] },
    aiConfidence: { type: 'NUMBER' },
    correctedClaim: { type: 'STRING', nullable: true },
    aiSummary: { type: 'STRING' },
    evidenceBasis: { type: 'STRING', enum: ['fact_check_match', 'fred_data', 'congress_data', 'general_knowledge', 'mixed'] },
  },
  required: ['aiVerdict', 'aiConfidence', 'aiSummary', 'evidenceBasis'],
};

export function buildPrompt(claimText: string, evidence: VerificationEvidence): string {
  const parts: string[] = [
    'You are a fact-check verification engine. Analyze the following claim using the provided evidence and return a structured verdict.',
    '',
    `CLAIM: "${claimText}"`,
    `CATEGORY: ${evidence.claimCategory ?? 'general'}`,
    `TYPE TAG: ${evidence.claimTypeTag ?? 'other'}`,
    '',
  ];

  const currentDate = evidence.currentDate ?? new Date().toISOString().slice(0, 10);
  parts.push(`CURRENT DATE: ${currentDate}`);
  if (evidence.speechContext) parts.push(`SPEECH CONTEXT: ${evidence.speechContext}`);
  parts.push('');

  const hasGoogleFc = evidence.googleFc?.verdict && evidence.googleFc.verdict !== 'unverified';
  const hasFred = evidence.fred?.state === 'matched';
  const hasCongress = evidence.congress?.state === 'matched';

  if (hasGoogleFc && evidence.googleFc) {
    parts.push('--- GOOGLE FACT CHECK EVIDENCE ---');
    parts.push(`Verdict: ${evidence.googleFc.verdict}`);
    parts.push(`Confidence: ${evidence.googleFc.confidence}`);
    parts.push(`Summary: ${evidence.googleFc.summary ?? 'N/A'}`);
    if (Array.isArray(evidence.googleFc.sources) && evidence.googleFc.sources.length > 0) {
      parts.push('Sources:');
      for (const s of evidence.googleFc.sources) {
        const name = s.publisher ?? s.url ?? String(s);
        const date = s.reviewDate ? ` (reviewed ${s.reviewDate})` : '';
        parts.push(`  - ${name}${date}`);
      }
    }
    parts.push('');
  }

  if (hasFred && evidence.fred) {
    parts.push('--- FRED ECONOMIC DATA EVIDENCE ---');
    parts.push(`Summary: ${evidence.fred.summary ?? 'N/A'}`);
    if (Array.isArray(evidence.fred.sources) && evidence.fred.sources.length > 0) {
      parts.push(`Sources: ${evidence.fred.sources.map((s) => s.seriesTitle ?? s.url ?? String(s)).join(', ')}`);
    }
    parts.push('');
  }

  if (hasCongress && evidence.congress) {
    parts.push('--- CONGRESS.GOV LEGISLATIVE DATA EVIDENCE ---');
    parts.push(`Summary: ${evidence.congress.summary ?? 'N/A'}`);
    if (Array.isArray(evidence.congress.sources) && evidence.congress.sources.length > 0) {
      parts.push(`Sources: ${evidence.congress.sources.map((s) => s.title ?? s.url ?? String(s)).join(', ')}`);
    }
    parts.push('');
  }

  parts.push('INSTRUCTIONS:');
  parts.push('- Determine if the claim is true, false, misleading, or unverified.');
  parts.push('- Use definitive language. Do NOT use probabilistic qualifiers like "highly unlikely", "probably", "may be", "appears to be". State facts directly.');
  parts.push(`- Evaluate claims as of ${currentDate}. If the claim references events, consider the most recent occurrence.`);
  parts.push('- When reviewing fact-check sources, consider the review date. A fact-check from a prior election cycle may not apply to the current claim.');
  parts.push('- Provide a confidence score between 0.0 and 1.0.');
  if (!hasGoogleFc && !hasFred && !hasCongress) {
    parts.push('- IMPORTANT: No external evidence sources were provided. You are relying on general knowledge only. Cap your confidence at 0.65 maximum.');
  }
  parts.push('- If the claim is false or misleading, provide a correctedClaim with the factually accurate version (max 484 characters).');
  parts.push('- If the claim is true, provide a correctedClaim that confirms the claim with supporting context (max 484 characters). Example: "This is confirmed. [Supporting data or context]."');
  parts.push('- Write the aiSummary as a contrastive narrative (max 484 characters). Format: "Although [brief paraphrase of claim], [verdict assessment]. [What evidence actually shows]." For true claims: "This claim is supported. [Confirming evidence]."');
  parts.push('- Set evidenceBasis to indicate what evidence you primarily relied on:');
  parts.push('  "fact_check_match" if Google Fact Check was the primary source,');
  parts.push('  "fred_data" if FRED economic data was primary,');
  parts.push('  "congress_data" if Congress.gov legislative data was primary,');
  parts.push('  "mixed" if you used multiple evidence sources,');
  parts.push('  "general_knowledge" if no external evidence was available.');

  if (evidence.operatorNotes) {
    parts.push('');
    parts.push('--- OPERATOR-PROVIDED CONTEXT ---');
    parts.push('The following facts have been verified by the production team and should be treated as ground truth:');
    parts.push(evidence.operatorNotes);
  }

  return parts.join('\n');
}

export function clampConfidence(result: VerificationResult, evidence: VerificationEvidence): VerificationResult {
  const hasGoogleFc = evidence.googleFc?.verdict && evidence.googleFc.verdict !== 'unverified';
  const hasFred = evidence.fred?.state === 'matched';
  const hasCongress = evidence.congress?.state === 'matched';

  if (!hasGoogleFc && !hasFred && !hasCongress && result.aiConfidence > 0.65) {
    return { ...result, aiConfidence: 0.65 };
  }
  return result;
}

export function normalizeResult(raw: Record<string, unknown>): VerificationResult {
  const validVerdicts: Verdict[] = ['true', 'false', 'misleading', 'unverified'];
  const verdict: Verdict = validVerdicts.includes(raw.aiVerdict as Verdict)
    ? (raw.aiVerdict as Verdict)
    : 'unverified';

  const confidence =
    typeof raw.aiConfidence === 'number' ? Math.max(0, Math.min(1, raw.aiConfidence)) : 0;

  const correctedClaim =
    typeof raw.correctedClaim === 'string' && raw.correctedClaim.trim()
      ? raw.correctedClaim.trim().slice(0, 484)
      : null;

  const aiSummary =
    typeof raw.aiSummary === 'string' && raw.aiSummary.trim()
      ? raw.aiSummary.trim().slice(0, 484)
      : null;

  const validBases: EvidenceBasis[] = ['fact_check_match', 'fred_data', 'congress_data', 'general_knowledge', 'mixed'];
  const evidenceBasis: EvidenceBasis = validBases.includes(raw.evidenceBasis as EvidenceBasis)
    ? (raw.evidenceBasis as EvidenceBasis)
    : 'general_knowledge';

  return { aiVerdict: verdict, aiConfidence: confidence, correctedClaim, aiSummary, evidenceBasis };
}

export interface VerifyClaimOptions {
  apiKey?: string;
  model?: string;
  signal?: AbortSignal;
}

export async function verifyClaim(
  claimText: string,
  evidence: VerificationEvidence | undefined,
  options?: VerifyClaimOptions
): Promise<VerificationResult> {
  const apiKey = options?.apiKey;
  const model = options?.model ?? 'gemini-2.5-flash';
  const signal = options?.signal;

  if (!apiKey) return { ...SAFE_FALLBACK };
  if (!claimText || typeof claimText !== 'string' || !claimText.trim()) return { ...SAFE_FALLBACK };

  const prompt = buildPrompt(claimText, evidence ?? {});

  let response: Response;
  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: RESPONSE_SCHEMA },
        }),
        signal,
      }
    );
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    log.error({ err: error }, 'network error');
    return { ...SAFE_FALLBACK };
  }

  if (!response.ok) {
    log.error({ status: response.status }, 'HTTP error');
    return { ...SAFE_FALLBACK };
  }

  let json: Record<string, unknown>;
  try {
    json = (await response.json()) as Record<string, unknown>;
  } catch (jsonError) {
    log.error({ err: jsonError }, 'response JSON parse error');
    return { ...SAFE_FALLBACK };
  }

  interface GeminiCandidate {
    content?: { parts?: Array<{ text?: string }> };
  }

  const text = (json?.candidates as GeminiCandidate[] | undefined)
    ?.flatMap((candidate) => candidate?.content?.parts ?? [])
    ?.map((part) => part?.text ?? '')
    ?.join('')
    ?.trim();

  if (!text) return { ...SAFE_FALLBACK };

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch (parseError) {
    log.error({ err: parseError }, 'structured output parse error');
    return { ...SAFE_FALLBACK };
  }

  const normalized = normalizeResult(parsed);
  return clampConfidence(normalized, evidence ?? {});
}
