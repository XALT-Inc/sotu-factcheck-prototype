import { describe, it, expect } from 'vitest';
import { scoreSentence, categorizeClaim, classifyClaimType, detectClaims } from './claim-detector.js';

describe('scoreSentence', () => {
  it('scores a sentence with a number', () => {
    const result = scoreSentence('Unemployment is at 3.5 percent nationwide.');
    expect(result.score).toBeGreaterThanOrEqual(0.45);
    expect(result.reasons).toContain('contains_number');
  });

  it('scores a sentence with a comparative', () => {
    const result = scoreSentence('Crime is higher than it has ever been before.');
    expect(result.reasons).toContain('contains_comparative');
  });

  it('scores a sentence with claim keywords', () => {
    const result = scoreSentence('Inflation is the worst it has ever been in history.');
    expect(result.reasons).toContain('contains_claim_keyword');
  });

  it('adds length bonus for sentences >= 8 words', () => {
    const result = scoreSentence('The economy is doing really well right now for everyone.');
    expect(result.reasons).toContain('sufficient_length');
  });

  it('does not add length bonus for short sentences', () => {
    const result = scoreSentence('Good economy now.');
    expect(result.reasons).not.toContain('sufficient_length');
  });

  it('caps score at 1.0', () => {
    const result = scoreSentence('The 500 billion dollar deficit is the highest ever recorded, more than the previous worst record.');
    expect(result.score).toBeLessThanOrEqual(1.0);
  });

  it('returns 0 for a non-factual sentence', () => {
    const result = scoreSentence('Thank you very much.');
    expect(result.score).toBe(0);
    expect(result.reasons).toHaveLength(0);
  });
});

describe('categorizeClaim', () => {
  it('categorizes economic claims', () => {
    expect(categorizeClaim('Unemployment is at an all-time low.')).toBe('economic');
    expect(categorizeClaim('GDP growth exceeded expectations this quarter.')).toBe('economic');
    expect(categorizeClaim('Inflation is destroying the middle class.')).toBe('economic');
  });

  it('categorizes political claims', () => {
    expect(categorizeClaim('The bill was passed by the senate unanimously.')).toBe('political');
    expect(categorizeClaim('She won the election by a landslide.')).toBe('political');
  });

  it('returns general for non-economic non-political claims', () => {
    expect(categorizeClaim('The sky is blue on a clear day.')).toBe('general');
  });
});

describe('classifyClaimType', () => {
  it('classifies numeric claims as numeric_factual', () => {
    expect(classifyClaimType('There are 15 million undocumented immigrants.', ['contains_number'])).toBe('numeric_factual');
  });

  it('classifies political verifiable claims as numeric_factual', () => {
    expect(classifyClaimType('The bill was passed by a unanimous vote.', ['contains_claim_keyword', 'contains_comparative'])).toBe('numeric_factual');
  });

  it('classifies comparative claims as simple_policy', () => {
    expect(classifyClaimType('Crime is increasing at alarming rates.', ['contains_comparative'])).toBe('simple_policy');
  });

  it('returns other for unclassifiable claims', () => {
    expect(classifyClaimType('The president said something important.', ['sufficient_length'])).toBe('other');
  });
});

describe('detectClaims', () => {
  it('detects claims above threshold', () => {
    const text = 'Unemployment is at 3.5 percent, the lowest ever recorded. Thank you.';
    const claims = detectClaims(text, { threshold: 0.5 });
    expect(claims.length).toBeGreaterThanOrEqual(1);
    expect(claims[0].text).toContain('3.5 percent');
  });

  it('returns empty for text below threshold', () => {
    const claims = detectClaims('Hello everybody. Thank you. Great to be here.', { threshold: 0.9 });
    expect(claims).toHaveLength(0);
  });

  it('skips sentences shorter than 20 characters', () => {
    const claims = detectClaims('Short. Very short.', { threshold: 0.1 });
    expect(claims).toHaveLength(0);
  });

  it('deduplicates identical sentences', () => {
    const text = 'The deficit is 1 trillion dollars. The deficit is 1 trillion dollars.';
    const claims = detectClaims(text, { threshold: 0.3 });
    expect(claims).toHaveLength(1);
  });

  it('passes chunkStartSec through to results', () => {
    const text = 'Unemployment is at 3.5 percent, the lowest in recorded history.';
    const claims = detectClaims(text, { threshold: 0.3, chunkStartSec: 120 });
    expect(claims.length).toBeGreaterThan(0);
    expect(claims[0].chunkStartSec).toBe(120);
  });

  it('includes category and claimTypeTag', () => {
    const text = 'GDP growth is at 4.2 percent this quarter, the highest in years.';
    const claims = detectClaims(text, { threshold: 0.3 });
    expect(claims.length).toBeGreaterThan(0);
    expect(claims[0].category).toBe('economic');
    expect(['numeric_factual', 'simple_policy', 'other']).toContain(claims[0].claimTypeTag);
  });
});
