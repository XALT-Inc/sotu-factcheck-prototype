function compactWhitespace(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(input) {
  return new Set(
    compactWhitespace(input)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2)
  );
}

function similarity(a, b) {
  const aTokens = tokenize(a);
  const bTokens = tokenize(b);

  if (aTokens.size === 0 || bTokens.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) {
      intersection += 1;
    }
  }

  const union = aTokens.size + bTokens.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function normalizeVerdict(textualRating = '') {
  const rating = compactWhitespace(textualRating).toLowerCase();

  if (!rating) {
    return 'unverified';
  }

  if (
    rating.includes('pants on fire') ||
    rating.includes('not true') ||
    rating.includes('debunked') ||
    rating.includes('no evidence') ||
    rating.includes('fake') ||
    rating.includes('hoax') ||
    rating.includes('fabricated') ||
    rating.includes('bogus') ||
    rating.includes('incorrect') ||
    rating.includes('false')
  ) {
    return 'false';
  }

  if (
    rating.includes('misleading') ||
    rating.includes('mostly false') ||
    rating.includes('partly false') ||
    rating.includes('half true') ||
    rating.includes('mixed') ||
    rating.includes('out of context') ||
    rating.includes('missing context') ||
    rating.includes('needs context') ||
    rating.includes('partly true')
  ) {
    return 'misleading';
  }

  if (
    rating.includes('mostly true') ||
    rating.includes('true') ||
    rating.includes('correct') ||
    rating.includes('accurate') ||
    rating.includes('authentic')
  ) {
    return 'true';
  }

  return 'unverified';
}

function verdictWeight(verdict) {
  switch (verdict) {
    case 'false':
    case 'misleading':
    case 'true':
      return 0.8;
    default:
      return 0.35;
  }
}

function buildQueryVariants(claimText) {
  const normalized = compactWhitespace(claimText);
  if (!normalized) {
    return [];
  }

  const variants = [normalized];
  const words = normalized.split(/\s+/);
  if (words.length > 18) {
    variants.push(words.slice(0, 18).join(' '));
  }

  const hasNumber = words.some((word) => /\d/.test(word));
  if (hasNumber && words.length > 12) {
    const focused = words
      .filter((word) => /\d/.test(word) || word.length > 4)
      .slice(0, 16)
      .join(' ')
      .trim();
    if (focused && focused !== normalized) {
      variants.push(focused);
    }
  }

  return [...new Set(variants)];
}

function candidatesFromApiClaims(claimText, apiClaims = []) {
  const candidates = [];

  for (const claim of apiClaims) {
    const reviewed = claim.text ?? '';

    for (const review of claim.claimReview ?? []) {
      const textualRating = review.textualRating ?? '';
      const verdict = normalizeVerdict(textualRating);
      const sourceText = [reviewed, review.title ?? '', textualRating].join(' ');
      const matchScore = similarity(claimText, sourceText);
      const weight = verdictWeight(verdict);

      // Hard cutoff: skip candidates older than 4 years entirely
      let recencyMultiplier = 1.0;
      if (review.reviewDate) {
        const reviewDate = new Date(review.reviewDate);
        const ageMs = Date.now() - reviewDate.getTime();
        const ageYears = ageMs / (365.25 * 24 * 60 * 60 * 1000);
        if (ageYears > 4) {
          continue; // Skip — wrong era
        }
        if (ageYears > 2) {
          recencyMultiplier = Math.max(0.5, 1.0 - (ageYears - 2) * 0.15);
        }
      }

      candidates.push({
        verdict,
        score: matchScore,
        confidence: Math.min(0.98, (0.25 + matchScore * 0.45 + weight * 0.3) * recencyMultiplier),
        claimReviewed: reviewed,
        textualRating,
        publisher: review.publisher?.name ?? 'Unknown publisher',
        url: review.url ?? null,
        reviewDate: review.reviewDate ?? null,
        title: review.title ?? null
      });
    }
  }

  return candidates;
}

export async function lookupFactChecks(claimText, options = {}) {
  const apiKey = options.apiKey;
  const pageSize = options.pageSize ?? 10;
  const signal = options.signal;
  const normalizedClaim = compactWhitespace(claimText);

  if (!apiKey) {
    return {
      status: 'needs_manual_research',
      verdict: 'unverified',
      confidence: 0,
      summary: 'Google Fact Check API key missing. Skipping automated evidence lookup.',
      sources: []
    };
  }

  const queryVariants = buildQueryVariants(normalizedClaim);
  if (queryVariants.length === 0) {
    return {
      status: 'needs_manual_research',
      verdict: 'unverified',
      confidence: 0,
      summary: 'Claim text is empty after normalization. Skipping automated evidence lookup.',
      sources: []
    };
  }

  try {
    let candidates = [];
    const languageVariants = ['en-US', 'en', null];

    for (const query of queryVariants) {
      for (const languageCode of languageVariants) {
        const url = new URL('https://factchecktools.googleapis.com/v1alpha1/claims:search');
        url.searchParams.set('query', query);
        if (languageCode) {
          url.searchParams.set('languageCode', languageCode);
        }
        url.searchParams.set('pageSize', String(pageSize));
        url.searchParams.set('key', apiKey);

        const response = await fetch(url, { signal });
        if (!response.ok) {
          const body = await response.text();
          console.error(`[factCheckClient] API error (${response.status}): ${body.slice(0, 160)}`);
          return {
            status: 'needs_manual_research',
            verdict: 'unverified',
            confidence: 0,
            summary: `Fact Check API request failed (${response.status}): ${body.slice(0, 160)}`,
            sources: []
          };
        }

        const data = await response.json();
        const parsed = candidatesFromApiClaims(normalizedClaim, data.claims ?? []);
        if (parsed.length === 0) {
          continue;
        }

        const next = new Map();
        for (const entry of [...candidates, ...parsed]) {
          const dedupeKey = `${entry.url ?? ''}|${entry.publisher}|${entry.claimReviewed}|${entry.textualRating}`;
          const existing = next.get(dedupeKey);
          if (!existing || entry.confidence > existing.confidence) {
            next.set(dedupeKey, entry);
          }
        }
        candidates = Array.from(next.values());
      }
    }

    if (candidates.length === 0) {
      return {
        status: 'no_match',
        verdict: 'unverified',
        confidence: 0.15,
        summary: 'No matching fact checks found from external organizations.',
        sources: []
      };
    }

    const classified = candidates.filter((entry) => entry.verdict !== 'unverified');
    const rankingPool = classified.length > 0 ? classified : candidates;

    rankingPool.sort((a, b) => b.confidence - a.confidence);
    const top = rankingPool[0];
    const sources = rankingPool.slice(0, 3).map((entry) => ({
      publisher: entry.publisher,
      url: entry.url,
      title: entry.title,
      textualRating: entry.textualRating,
      claimReviewed: entry.claimReviewed,
      reviewDate: entry.reviewDate
    }));

    return {
      status: top.verdict === 'unverified' ? 'needs_manual_research' : 'researched',
      verdict: top.verdict,
      confidence: Number(top.confidence.toFixed(2)),
      summary: `${top.publisher}: rated '${top.textualRating || 'unrated'}' for claim '${top.claimReviewed.slice(0, 120)}'`,
      sources
    };
  } catch (error) {
    console.error('[factCheckClient] Lookup error:', error.message);
    return {
      status: 'needs_manual_research',
      verdict: 'unverified',
      confidence: 0,
      summary: `Fact-check lookup error: ${error.message}`,
      sources: []
    };
  }
}
