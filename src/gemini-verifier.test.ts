import { describe, it, expect } from 'vitest';
import { buildPrompt, clampConfidence, normalizeResult } from './gemini-verifier.js';

describe('buildPrompt', () => {
  it('includes the claim text', () => {
    const prompt = buildPrompt('Unemployment is 3.5%', {});
    expect(prompt).toContain('Unemployment is 3.5%');
  });

  it('includes category and type tag', () => {
    const prompt = buildPrompt('Test claim', { claimCategory: 'economic', claimTypeTag: 'numeric_factual' });
    expect(prompt).toContain('economic');
    expect(prompt).toContain('numeric_factual');
  });

  it('includes Google FC evidence when present', () => {
    const prompt = buildPrompt('Test claim', {
      googleFc: { verdict: 'false', confidence: 0.9, summary: 'Rated false by PolitiFact', sources: [] },
    });
    expect(prompt).toContain('GOOGLE FACT CHECK EVIDENCE');
    expect(prompt).toContain('Rated false by PolitiFact');
  });

  it('includes FRED evidence when matched', () => {
    const prompt = buildPrompt('Test claim', {
      fred: { state: 'matched', summary: 'CPI data shows 3.2%', sources: [] },
    });
    expect(prompt).toContain('FRED ECONOMIC DATA EVIDENCE');
    expect(prompt).toContain('CPI data shows 3.2%');
  });

  it('includes Congress evidence when matched', () => {
    const prompt = buildPrompt('Test claim', {
      congress: { state: 'matched', summary: 'Bill HR 1234 passed', sources: [] },
    });
    expect(prompt).toContain('CONGRESS.GOV LEGISLATIVE DATA EVIDENCE');
    expect(prompt).toContain('Bill HR 1234 passed');
  });

  it('omits evidence sections when not matched', () => {
    const prompt = buildPrompt('Test claim', {
      googleFc: { verdict: 'unverified', confidence: 0, summary: '', sources: [] },
      fred: { state: 'not_applicable', summary: '', sources: [] },
    });
    expect(prompt).not.toContain('GOOGLE FACT CHECK EVIDENCE');
    expect(prompt).not.toContain('FRED ECONOMIC DATA EVIDENCE');
  });

  it('includes general knowledge warning when no evidence', () => {
    const prompt = buildPrompt('Test claim', {});
    expect(prompt).toContain('Cap your confidence at 0.65 maximum');
  });

  it('includes operator notes when provided', () => {
    const prompt = buildPrompt('Test claim', { operatorNotes: 'The speaker misspoke about the year.' });
    expect(prompt).toContain('OPERATOR-PROVIDED CONTEXT');
    expect(prompt).toContain('The speaker misspoke about the year.');
  });

  it('includes speech context when provided', () => {
    const prompt = buildPrompt('Test claim', { speechContext: 'State of the Union 2024' });
    expect(prompt).toContain('SPEECH CONTEXT: State of the Union 2024');
  });
});

describe('clampConfidence', () => {
  it('clamps confidence to 0.65 without external evidence', () => {
    const result = clampConfidence(
      { aiVerdict: 'true', aiConfidence: 0.9, correctedClaim: null, aiSummary: null, evidenceBasis: 'general_knowledge' },
      {}
    );
    expect(result.aiConfidence).toBe(0.65);
  });

  it('does not clamp when Google FC evidence exists', () => {
    const result = clampConfidence(
      { aiVerdict: 'true', aiConfidence: 0.9, correctedClaim: null, aiSummary: null, evidenceBasis: 'fact_check_match' },
      { googleFc: { verdict: 'true', confidence: 0.8, summary: '', sources: [] } }
    );
    expect(result.aiConfidence).toBe(0.9);
  });

  it('does not clamp when FRED evidence exists', () => {
    const result = clampConfidence(
      { aiVerdict: 'true', aiConfidence: 0.85, correctedClaim: null, aiSummary: null, evidenceBasis: 'fred_data' },
      { fred: { state: 'matched', summary: '', sources: [] } }
    );
    expect(result.aiConfidence).toBe(0.85);
  });

  it('does not clamp when Congress evidence exists', () => {
    const result = clampConfidence(
      { aiVerdict: 'true', aiConfidence: 0.85, correctedClaim: null, aiSummary: null, evidenceBasis: 'congress_data' },
      { congress: { state: 'matched', summary: '', sources: [] } }
    );
    expect(result.aiConfidence).toBe(0.85);
  });

  it('does not clamp when confidence is already <= 0.65', () => {
    const result = clampConfidence(
      { aiVerdict: 'unverified', aiConfidence: 0.5, correctedClaim: null, aiSummary: null, evidenceBasis: 'general_knowledge' },
      {}
    );
    expect(result.aiConfidence).toBe(0.5);
  });
});

describe('normalizeResult', () => {
  it('normalizes a valid result', () => {
    const result = normalizeResult({
      aiVerdict: 'false',
      aiConfidence: 0.85,
      correctedClaim: 'The actual rate is 4.2%',
      aiSummary: 'Although the speaker claimed...',
      evidenceBasis: 'fact_check_match',
    });
    expect(result.aiVerdict).toBe('false');
    expect(result.aiConfidence).toBe(0.85);
    expect(result.correctedClaim).toBe('The actual rate is 4.2%');
    expect(result.aiSummary).toBe('Although the speaker claimed...');
    expect(result.evidenceBasis).toBe('fact_check_match');
  });

  it('defaults invalid verdict to unverified', () => {
    const result = normalizeResult({ aiVerdict: 'maybe', aiConfidence: 0.5, aiSummary: 'test', evidenceBasis: 'mixed' });
    expect(result.aiVerdict).toBe('unverified');
  });

  it('clamps confidence between 0 and 1', () => {
    expect(normalizeResult({ aiConfidence: 1.5 }).aiConfidence).toBe(1);
    expect(normalizeResult({ aiConfidence: -0.5 }).aiConfidence).toBe(0);
  });

  it('defaults missing confidence to 0', () => {
    expect(normalizeResult({}).aiConfidence).toBe(0);
  });

  it('trims and truncates correctedClaim at 484 chars', () => {
    const long = 'x'.repeat(600);
    const result = normalizeResult({ correctedClaim: long });
    expect(result.correctedClaim!.length).toBe(484);
  });

  it('returns null correctedClaim for empty string', () => {
    expect(normalizeResult({ correctedClaim: '' }).correctedClaim).toBeNull();
    expect(normalizeResult({ correctedClaim: '   ' }).correctedClaim).toBeNull();
  });

  it('defaults invalid evidenceBasis to general_knowledge', () => {
    expect(normalizeResult({ evidenceBasis: 'invalid' }).evidenceBasis).toBe('general_knowledge');
  });

  it('trims and truncates aiSummary at 484 chars', () => {
    const long = 'y'.repeat(600);
    const result = normalizeResult({ aiSummary: long });
    expect(result.aiSummary!.length).toBe(484);
  });

  it('returns null aiSummary for empty string', () => {
    expect(normalizeResult({ aiSummary: '' }).aiSummary).toBeNull();
  });
});
