import type { CongressResult, CongressBillDetails } from './types.js';
import { CONGRESS_NOT_APPLICABLE_SUMMARY } from './constants.js';
import { createLogger } from './logger.js';

const log = createLogger('congress-client');

interface BillCatalogEntry {
  keywords: string[];
  congress: number;
  type: string;
  number: number;
  title: string;
}

const BILL_CATALOG: BillCatalogEntry[] = [
  { keywords: ['infrastructure', 'roads', 'bridges'], congress: 117, type: 'hr', number: 3684, title: 'Infrastructure Investment and Jobs Act' },
  { keywords: ['inflation reduction', 'climate', 'clean energy'], congress: 117, type: 'hr', number: 5376, title: 'Inflation Reduction Act' },
  { keywords: ['chips', 'semiconductor'], congress: 117, type: 'hr', number: 4346, title: 'CHIPS and Science Act' },
  { keywords: ['bipartisan safer communities', 'gun safety', 'gun control'], congress: 117, type: 's', number: 2938, title: 'Bipartisan Safer Communities Act' },
  { keywords: ['respect for marriage', 'same-sex marriage', 'marriage act'], congress: 117, type: 'hr', number: 8404, title: 'Respect for Marriage Act' },
  { keywords: ['pact act', 'burn pit', 'toxic exposure', 'veterans health'], congress: 117, type: 's', number: 3373, title: 'PACT Act' },
  { keywords: ['electoral count', 'electoral reform'], congress: 117, type: 'hr', number: 55, title: 'Electoral Count Reform Act' },
  { keywords: ['debt ceiling', 'debt limit', 'fiscal responsibility'], congress: 118, type: 'hr', number: 3746, title: 'Fiscal Responsibility Act' },
  { keywords: ['ndaa', 'defense authorization', 'military spending'], congress: 118, type: 'hr', number: 2670, title: 'National Defense Authorization Act FY2024' },
  { keywords: ['faa reauthorization', 'aviation', 'air traffic'], congress: 118, type: 'hr', number: 3935, title: 'FAA Reauthorization Act' },
];

const LEGISLATIVE_KEYWORDS: string[] = [
  'bill', 'passed', 'signed', 'law', 'legislation', 'act', 'bipartisan',
  'vote', 'voted', 'confirmed', 'nomination', 'congress', 'senate', 'house',
];

function detectBills(claimText: string): { relevant: boolean; bills: BillCatalogEntry[] } {
  const lower = claimText.toLowerCase();
  const hasLegislativeKeyword = LEGISLATIVE_KEYWORDS.some((keyword) => lower.includes(keyword));
  if (!hasLegislativeKeyword) return { relevant: false, bills: [] };

  const matches: BillCatalogEntry[] = [];
  for (const bill of BILL_CATALOG) {
    if (bill.keywords.some((keyword) => lower.includes(keyword))) {
      matches.push(bill);
    }
  }

  const unique = new Map<string, BillCatalogEntry>();
  for (const bill of matches) {
    const key = `${bill.congress}-${bill.type}-${bill.number}`;
    unique.set(key, bill);
  }

  return { relevant: true, bills: Array.from(unique.values()).slice(0, 3) };
}

function billUrl(congress: number, type: string, number: number): string {
  return `https://www.congress.gov/bill/${congress}th-congress/${type === 'hr' ? 'house-bill' : 'senate-bill'}/${number}`;
}

interface FetchBillOptions {
  apiKey: string;
  signal?: AbortSignal;
}

async function fetchBillDetails(
  bill: BillCatalogEntry,
  options: FetchBillOptions
): Promise<CongressBillDetails | null> {
  const url = new URL(`https://api.congress.gov/v3/bill/${bill.congress}/${bill.type}/${bill.number}`);
  url.searchParams.set('api_key', options.apiKey);
  url.searchParams.set('format', 'json');

  const response = await fetch(url, { signal: options.signal });

  if (!response.ok) {
    const body = await response.text();
    log.error({ status: response.status, body: body.slice(0, 160) }, 'API error');
    throw new Error(`Congress API failed (${response.status}): ${body.slice(0, 140)}`);
  }

  const data = (await response.json()) as {
    bill?: {
      title?: string;
      latestAction?: { text?: string; actionDate?: string };
      laws?: unknown[];
      cosponsors?: number;
    };
  };
  const billData = data.bill;
  if (!billData) return null;

  const latestAction = billData.latestAction?.text ?? 'No action recorded';
  const latestActionDate = billData.latestAction?.actionDate ?? null;
  const becameLaw =
    latestAction.toLowerCase().includes('became public law') ||
    (Array.isArray(billData.laws) && billData.laws.length > 0);
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
    url: billUrl(bill.congress, bill.type, bill.number),
  };
}

export interface LookupCongressOptions {
  apiKey?: string;
  signal?: AbortSignal;
}

export async function lookupCongressEvidence(
  claimText: string,
  options: LookupCongressOptions = {}
): Promise<CongressResult> {
  const { relevant, bills } = detectBills(claimText);

  if (!relevant) {
    return {
      state: 'not_applicable',
      summary: CONGRESS_NOT_APPLICABLE_SUMMARY,
      sources: [],
    };
  }

  if (!options.apiKey) {
    return {
      state: 'error',
      summary: 'Congress.gov API key missing for legislative claim enrichment.',
      sources: [],
    };
  }

  if (bills.length === 0) {
    return {
      state: 'ambiguous',
      summary: 'Legislative keywords detected but no specific bill matched from catalog.',
      sources: [],
    };
  }

  try {
    const settled = await Promise.allSettled(
      bills.map((bill) => fetchBillDetails(bill, { apiKey: options.apiKey!, signal: options.signal }))
    );
    const sources = settled
      .filter((r): r is PromiseFulfilledResult<CongressBillDetails | null> => r.status === 'fulfilled' && r.value !== null)
      .map((r) => r.value!);

    if (sources.length === 0) {
      return {
        state: 'ambiguous',
        summary: 'Congress API returned no usable bill data for matched entries.',
        sources: [],
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
      sources,
    };
  } catch (error) {
    log.error({ err: error }, 'lookup error');
    return {
      state: 'error',
      summary: `Congress.gov lookup error: ${(error as Error).message}`,
      sources: [],
    };
  }
}
