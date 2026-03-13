import type { FredResult, FredObservation } from './types.js';
import { FRED_NOT_APPLICABLE_SUMMARY } from './constants.js';

interface FredSeries {
  id: string;
  title: string;
  keywords: string[];
}

const SERIES_CATALOG: FredSeries[] = [
  { id: 'UNRATE', title: 'Unemployment Rate', keywords: ['unemployment', 'jobless'] },
  { id: 'PAYEMS', title: 'All Employees, Total Nonfarm Payrolls', keywords: ['jobs', 'payroll'] },
  { id: 'CPIAUCSL', title: 'Consumer Price Index for All Urban Consumers', keywords: ['inflation', 'cpi', 'consumer prices'] },
  { id: 'GDP', title: 'Gross Domestic Product', keywords: ['gdp', 'economy growth', 'economic growth'] },
  { id: 'CES0500000003', title: 'Average Hourly Earnings of All Employees, Private', keywords: ['wages', 'hourly earnings'] },
  { id: 'GFDEBTN', title: 'Federal Debt: Total Public Debt', keywords: ['debt', 'national debt'] },
  { id: 'FYFSD', title: 'Federal Surplus or Deficit', keywords: ['deficit', 'surplus'] },
  { id: 'FEDFUNDS', title: 'Federal Funds Effective Rate', keywords: ['interest rate', 'federal reserve', 'fed rate', 'fed funds'] },
];

function detectSeries(claimText: string): FredSeries[] {
  const lower = claimText.toLowerCase();
  const matches: FredSeries[] = [];

  for (const series of SERIES_CATALOG) {
    if (series.keywords.some((keyword) => lower.includes(keyword))) {
      matches.push(series);
    }
  }

  const unique = new Map<string, FredSeries>();
  for (const series of matches) {
    unique.set(series.id, series);
  }

  return Array.from(unique.values()).slice(0, 3);
}

function seriesUrl(seriesId: string): string {
  const url = new URL('https://fred.stlouisfed.org/series/');
  url.pathname += seriesId;
  return url.toString();
}

interface FetchOptions {
  apiKey: string;
  signal?: AbortSignal;
}

async function fetchLatestObservation(
  series: FredSeries,
  options: FetchOptions
): Promise<FredObservation | null> {
  const url = new URL('https://api.stlouisfed.org/fred/series/observations');
  url.searchParams.set('series_id', series.id);
  url.searchParams.set('api_key', options.apiKey);
  url.searchParams.set('file_type', 'json');
  url.searchParams.set('sort_order', 'desc');
  url.searchParams.set('limit', '1');

  const response = await fetch(url, { signal: options.signal });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`FRED lookup failed (${response.status}): ${body.slice(0, 140)}`);
  }

  const data = (await response.json()) as {
    observations?: Array<{ date: string; value: string }>;
  };
  const observation = Array.isArray(data.observations) ? data.observations[0] : null;
  if (!observation || observation.value === '.') return null;

  return {
    seriesId: series.id,
    seriesTitle: series.title,
    observationDate: observation.date,
    value: Number(observation.value),
    url: seriesUrl(series.id),
  };
}

export interface LookupFredOptions {
  apiKey?: string;
  signal?: AbortSignal;
}

export async function lookupFredEvidence(
  claimText: string,
  options: LookupFredOptions = {}
): Promise<FredResult> {
  const seriesList = detectSeries(claimText);
  if (seriesList.length === 0) {
    return {
      state: 'not_applicable',
      summary: FRED_NOT_APPLICABLE_SUMMARY,
      sources: [],
    };
  }

  if (!options.apiKey) {
    return {
      state: 'error',
      summary: 'FRED API key missing for economic claim enrichment.',
      sources: [],
    };
  }

  try {
    const rows = await Promise.all(
      seriesList.map((series) => fetchLatestObservation(series, { apiKey: options.apiKey!, signal: options.signal }))
    );
    const sources = rows.filter((r): r is FredObservation => r !== null);

    if (sources.length === 0) {
      return {
        state: 'ambiguous',
        summary: 'FRED returned no usable observations for mapped indicators.',
        sources: [],
      };
    }

    const summary = sources
      .map((source) => `${source.seriesTitle}: ${source.value} (${source.observationDate})`)
      .join(' | ');

    return {
      state: 'matched',
      summary: `FRED indicators retrieved. ${summary}`,
      sources,
    };
  } catch (error) {
    return {
      state: 'error',
      summary: `FRED lookup error: ${(error as Error).message}`,
      sources: [],
    };
  }
}
