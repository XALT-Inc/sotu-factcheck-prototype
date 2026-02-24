const CLAIM_KEYWORDS = [
  'lowest',
  'highest',
  'best',
  'worst',
  'record',
  'ever',
  'million',
  'billion',
  'trillion',
  'percent',
  'inflation',
  'unemployment',
  'jobs',
  'deficit',
  'debt',
  'crime',
  'border',
  'tax',
  'wages',
  'gdp',
  'economy',
  'growth'
];

const ECONOMIC_KEYWORDS = [
  'inflation',
  'unemployment',
  'jobs',
  'wages',
  'gdp',
  'economy',
  'growth',
  'deficit',
  'debt',
  'tax',
  'federal reserve',
  'interest rate',
  'cpi',
  'labor force'
];

const COMPARATIVE_PATTERN =
  /\b(more|less|higher|lower|up|down|increase(?:d)?|decrease(?:d)?|than|fewer)\b/i;

function splitSentences(text) {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function scoreSentence(sentence) {
  const lower = sentence.toLowerCase();
  const reasons = [];
  let score = 0;

  const hasNumber = /\d/.test(lower);
  if (hasNumber) {
    score += 0.45;
    reasons.push('contains_number');
  }

  if (COMPARATIVE_PATTERN.test(lower)) {
    score += 0.2;
    reasons.push('contains_comparative');
  }

  const keywordMatches = CLAIM_KEYWORDS.filter((k) => lower.includes(k));
  if (keywordMatches.length > 0) {
    score += Math.min(0.35, keywordMatches.length * 0.1);
    reasons.push('contains_claim_keyword');
  }

  if (sentence.split(/\s+/).length >= 8) {
    score += 0.1;
    reasons.push('sufficient_length');
  }

  const normalized = Math.min(1, score);
  return { score: normalized, reasons };
}

function categorizeClaim(sentence) {
  const lower = sentence.toLowerCase();
  const hasEconomicKeyword = ECONOMIC_KEYWORDS.some((keyword) => lower.includes(keyword));
  return hasEconomicKeyword ? 'economic' : 'general';
}

function classifyClaimType(sentence, reasons) {
  const lower = sentence.toLowerCase();
  const hasNumber = /\d/.test(lower) || reasons.includes('contains_number');
  if (hasNumber) {
    return 'numeric_factual';
  }

  if (COMPARATIVE_PATTERN.test(lower) || reasons.includes('contains_comparative')) {
    return 'simple_policy';
  }

  return 'other';
}

export function detectClaims(text, options = {}) {
  const threshold = options.threshold ?? 0.55;
  const chunkStartSec = options.chunkStartSec ?? 0;

  const seen = new Set();
  const claims = [];

  for (const sentence of splitSentences(text)) {
    const cleaned = sentence.replace(/^[-\u2022\s]+/, '').trim();
    if (cleaned.length < 20) {
      continue;
    }

    const key = cleaned.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    const { score, reasons } = scoreSentence(cleaned);
    if (score < threshold) {
      continue;
    }

    seen.add(key);
    claims.push({
      text: cleaned,
      score,
      reasons,
      chunkStartSec,
      category: categorizeClaim(cleaned),
      claimTypeTag: classifyClaimType(cleaned, reasons),
      claimTypeConfidence: Number(score.toFixed(2))
    });
  }

  return claims;
}
