const BILL_CATALOG = [
  {
    keywords: ['infrastructure', 'roads', 'bridges'],
    congress: 117,
    type: 'hr',
    number: 3684,
    title: 'Infrastructure Investment and Jobs Act'
  },
  {
    keywords: ['inflation reduction', 'climate', 'clean energy'],
    congress: 117,
    type: 'hr',
    number: 5376,
    title: 'Inflation Reduction Act'
  },
  {
    keywords: ['chips', 'semiconductor'],
    congress: 117,
    type: 'hr',
    number: 4346,
    title: 'CHIPS and Science Act'
  },
  {
    keywords: ['bipartisan safer communities', 'gun safety', 'gun control'],
    congress: 117,
    type: 's',
    number: 2938,
    title: 'Bipartisan Safer Communities Act'
  },
  {
    keywords: ['respect for marriage', 'same-sex marriage', 'marriage act'],
    congress: 117,
    type: 'hr',
    number: 8404,
    title: 'Respect for Marriage Act'
  },
  {
    keywords: ['pact act', 'burn pit', 'toxic exposure', 'veterans health'],
    congress: 117,
    type: 's',
    number: 3373,
    title: 'PACT Act'
  },
  {
    keywords: ['electoral count', 'electoral reform'],
    congress: 117,
    type: 'hr',
    number: 55,
    title: 'Electoral Count Reform Act'
  },
  {
    keywords: ['debt ceiling', 'debt limit', 'fiscal responsibility'],
    congress: 118,
    type: 'hr',
    number: 3746,
    title: 'Fiscal Responsibility Act'
  },
  {
    keywords: ['ndaa', 'defense authorization', 'military spending'],
    congress: 118,
    type: 'hr',
    number: 2670,
    title: 'National Defense Authorization Act FY2024'
  },
  {
    keywords: ['faa reauthorization', 'aviation', 'air traffic'],
    congress: 118,
    type: 'hr',
    number: 3935,
    title: 'FAA Reauthorization Act'
  }
];

const LEGISLATIVE_KEYWORDS = [
  'bill',
  'passed',
  'signed',
  'law',
  'legislation',
  'act',
  'bipartisan',
  'vote',
  'voted',
  'confirmed',
  'nomination',
  'congress',
  'senate',
  'house'
];

function detectBills(claimText) {
  const lower = claimText.toLowerCase();

  // Check for legislative relevance first
  const hasLegislativeKeyword = LEGISLATIVE_KEYWORDS.some((keyword) => lower.includes(keyword));
  if (!hasLegislativeKeyword) {
    return { relevant: false, bills: [] };
  }

  const matches = [];
  for (const bill of BILL_CATALOG) {
    if (bill.keywords.some((keyword) => lower.includes(keyword))) {
      matches.push(bill);
    }
  }

  const unique = new Map();
  for (const bill of matches) {
    const key = `${bill.congress}-${bill.type}-${bill.number}`;
    unique.set(key, bill);
  }

  return { relevant: true, bills: Array.from(unique.values()).slice(0, 3) };
}

function billUrl(congress, type, number) {
  return `https://www.congress.gov/bill/${congress}th-congress/${type === 'hr' ? 'house-bill' : 'senate-bill'}/${number}`;
}

async function fetchBillDetails(bill, options) {
  const url = new URL(
    `https://api.congress.gov/v3/bill/${bill.congress}/${bill.type}/${bill.number}`
  );
  url.searchParams.set('api_key', options.apiKey);
  url.searchParams.set('format', 'json');

  const response = await fetch(url, { signal: options.signal });

  if (!response.ok) {
    const body = await response.text();
    console.error(`[congressClient] API error (${response.status}): ${body.slice(0, 160)}`);
    throw new Error(`Congress API failed (${response.status}): ${body.slice(0, 140)}`);
  }

  const data = await response.json();
  const billData = data.bill;
  if (!billData) {
    return null;
  }

  const latestAction = billData.latestAction?.text ?? 'No action recorded';
  const latestActionDate = billData.latestAction?.actionDate ?? null;
  const becameLaw = latestAction.toLowerCase().includes('became public law') ||
    (billData.laws && billData.laws.length > 0);
  const cosponsors = billData.cosponsors ?? 0;

  return {
    congress: bill.congress,
    type: bill.type,
    number: bill.number,
    title: billData.title ?? bill.title,
    latestAction,
    latestActionDate,
    becameLaw,
    cosponsors,
    url: billUrl(bill.congress, bill.type, bill.number)
  };
}

export async function lookupCongressEvidence(claimText, options = {}) {
  const { relevant, bills } = detectBills(claimText);

  if (!relevant) {
    return {
      state: 'not_applicable',
      summary: 'No legislative keywords detected in this claim.',
      sources: []
    };
  }

  if (!options.apiKey) {
    return {
      state: 'error',
      summary: 'Congress.gov API key missing for legislative claim enrichment.',
      sources: []
    };
  }

  if (bills.length === 0) {
    return {
      state: 'ambiguous',
      summary: 'Legislative keywords detected but no specific bill matched from catalog.',
      sources: []
    };
  }

  try {
    const settled = await Promise.allSettled(
      bills.map((bill) => fetchBillDetails(bill, options))
    );
    const sources = settled
      .filter((r) => r.status === 'fulfilled' && r.value)
      .map((r) => r.value);

    if (sources.length === 0) {
      return {
        state: 'ambiguous',
        summary: 'Congress API returned no usable bill data for matched entries.',
        sources: []
      };
    }

    const summary = sources
      .map((s) => {
        const lawStatus = s.becameLaw ? 'Signed into law' : 'Not enacted';
        return `${s.title}: ${lawStatus}. Latest action (${s.latestActionDate ?? 'N/A'}): ${s.latestAction}`;
      })
      .join(' | ');

    return {
      state: 'matched',
      summary: `Congress.gov data retrieved. ${summary}`,
      sources
    };
  } catch (error) {
    console.error('[congressClient] Lookup error:', error.message);
    return {
      state: 'error',
      summary: `Congress.gov lookup error: ${error.message}`,
      sources: []
    };
  }
}
