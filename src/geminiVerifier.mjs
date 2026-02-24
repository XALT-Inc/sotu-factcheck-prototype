const SAFE_FALLBACK = {
  aiVerdict: 'unverified',
  aiConfidence: 0,
  correctedClaim: null,
  aiSummary: null,
  evidenceBasis: null
};

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    aiVerdict: {
      type: 'STRING',
      enum: ['true', 'false', 'misleading', 'unverified']
    },
    aiConfidence: {
      type: 'NUMBER'
    },
    correctedClaim: {
      type: 'STRING',
      nullable: true
    },
    aiSummary: {
      type: 'STRING'
    },
    evidenceBasis: {
      type: 'STRING',
      enum: ['fact_check_match', 'fred_data', 'congress_data', 'general_knowledge', 'mixed']
    }
  },
  required: ['aiVerdict', 'aiConfidence', 'aiSummary', 'evidenceBasis']
};

function buildPrompt(claimText, evidence) {
  const parts = [
    'You are a fact-check verification engine. Analyze the following claim using the provided evidence and return a structured verdict.',
    '',
    `CLAIM: "${claimText}"`,
    `CATEGORY: ${evidence.claimCategory ?? 'general'}`,
    `TYPE TAG: ${evidence.claimTypeTag ?? 'other'}`,
    ''
  ];

  const currentDate = evidence.currentDate ?? new Date().toISOString().slice(0, 10);
  parts.push(`CURRENT DATE: ${currentDate}`);
  if (evidence.speechContext) {
    parts.push(`SPEECH CONTEXT: ${evidence.speechContext}`);
  }
  parts.push('');

  const hasGoogleFc =
    evidence.googleFc &&
    evidence.googleFc.verdict &&
    evidence.googleFc.verdict !== 'unverified';

  const hasFred =
    evidence.fred &&
    evidence.fred.state === 'matched';

  if (hasGoogleFc) {
    parts.push('--- GOOGLE FACT CHECK EVIDENCE ---');
    parts.push(`Verdict: ${evidence.googleFc.verdict}`);
    parts.push(`Confidence: ${evidence.googleFc.confidence}`);
    parts.push(`Summary: ${evidence.googleFc.summary ?? 'N/A'}`);
    if (Array.isArray(evidence.googleFc.sources) && evidence.googleFc.sources.length > 0) {
      parts.push('Sources:');
      for (const s of evidence.googleFc.sources) {
        const name = s.publisher ?? s.name ?? s.url ?? String(s);
        const date = s.reviewDate ? ` (reviewed ${s.reviewDate})` : '';
        parts.push(`  - ${name}${date}`);
      }
    }
    parts.push('');
  }

  if (hasFred) {
    parts.push('--- FRED ECONOMIC DATA EVIDENCE ---');
    parts.push(`Summary: ${evidence.fred.summary ?? 'N/A'}`);
    if (Array.isArray(evidence.fred.sources) && evidence.fred.sources.length > 0) {
      parts.push(`Sources: ${evidence.fred.sources.map((s) => s.name ?? s.url ?? s).join(', ')}`);
    }
    parts.push('');
  }

  const hasCongress =
    evidence.congress &&
    evidence.congress.state === 'matched';

  if (hasCongress) {
    parts.push('--- CONGRESS.GOV LEGISLATIVE DATA EVIDENCE ---');
    parts.push(`Summary: ${evidence.congress.summary ?? 'N/A'}`);
    if (Array.isArray(evidence.congress.sources) && evidence.congress.sources.length > 0) {
      parts.push(`Sources: ${evidence.congress.sources.map((s) => s.title ?? s.url ?? s).join(', ')}`);
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

function clampConfidence(result, evidence) {
  const hasGoogleFc =
    evidence.googleFc &&
    evidence.googleFc.verdict &&
    evidence.googleFc.verdict !== 'unverified';

  const hasFred =
    evidence.fred &&
    evidence.fred.state === 'matched';

  const hasCongress =
    evidence.congress &&
    evidence.congress.state === 'matched';

  if (!hasGoogleFc && !hasFred && !hasCongress && result.aiConfidence > 0.65) {
    return { ...result, aiConfidence: 0.65 };
  }

  return result;
}

function normalizeResult(raw) {
  const verdict = ['true', 'false', 'misleading', 'unverified'].includes(raw.aiVerdict)
    ? raw.aiVerdict
    : 'unverified';

  const confidence = typeof raw.aiConfidence === 'number'
    ? Math.max(0, Math.min(1, raw.aiConfidence))
    : 0;

  const correctedClaim =
    typeof raw.correctedClaim === 'string' && raw.correctedClaim.trim()
      ? raw.correctedClaim.trim().slice(0, 484)
      : null;

  const aiSummary =
    typeof raw.aiSummary === 'string' && raw.aiSummary.trim()
      ? raw.aiSummary.trim().slice(0, 484)
      : null;

  const validBases = ['fact_check_match', 'fred_data', 'congress_data', 'general_knowledge', 'mixed'];
  const evidenceBasis = validBases.includes(raw.evidenceBasis)
    ? raw.evidenceBasis
    : 'general_knowledge';

  return { aiVerdict: verdict, aiConfidence: confidence, correctedClaim, aiSummary, evidenceBasis };
}

export async function verifyClaim(claimText, evidence, options) {
  const apiKey = options?.apiKey;
  const model = options?.model ?? 'gemini-2.5-flash';
  const signal = options?.signal;

  if (!apiKey) {
    return { ...SAFE_FALLBACK };
  }

  if (!claimText || typeof claimText !== 'string' || !claimText.trim()) {
    return { ...SAFE_FALLBACK };
  }

  const prompt = buildPrompt(claimText, evidence ?? {});

  let response;
  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: prompt }]
            }
          ],
          generationConfig: {
            temperature: 0,
            responseMimeType: 'application/json',
            responseSchema: RESPONSE_SCHEMA
          }
        }),
        signal
      }
    );
  } catch (error) {
    if (error.name === 'AbortError') {
      throw error;
    }
    console.error('[geminiVerifier] Network error:', error.message);
    return { ...SAFE_FALLBACK };
  }

  if (!response.ok) {
    console.error(`[geminiVerifier] HTTP error: ${response.status}`);
    return { ...SAFE_FALLBACK };
  }

  let json;
  try {
    json = await response.json();
  } catch (jsonError) {
    console.error('[geminiVerifier] Response JSON parse error:', jsonError.message);
    return { ...SAFE_FALLBACK };
  }

  const text = json?.candidates
    ?.flatMap((candidate) => candidate?.content?.parts ?? [])
    ?.map((part) => part?.text ?? '')
    ?.join('')
    ?.trim();

  if (!text) {
    return { ...SAFE_FALLBACK };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (parseError) {
    console.error('[geminiVerifier] Structured output parse error:', parseError.message);
    return { ...SAFE_FALLBACK };
  }

  const normalized = normalizeResult(parsed);
  return clampConfidence(normalized, evidence ?? {});
}
