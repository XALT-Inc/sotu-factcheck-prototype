import { describe, it, expect } from 'vitest';
import { similarity, normalizeVerdict, buildQueryVariants } from './fact-check-client.js';

describe('similarity (Jaccard)', () => {
  it('returns 1 for identical strings', () => {
    expect(similarity('hello world foo', 'hello world foo')).toBe(1);
  });

  it('returns 0 for completely different strings', () => {
    expect(similarity('apple banana cherry', 'xyz uvw rst')).toBe(0);
  });

  it('returns 0 for empty strings', () => {
    expect(similarity('', 'hello world foo')).toBe(0);
    expect(similarity('hello world foo', '')).toBe(0);
    expect(similarity('', '')).toBe(0);
  });

  it('returns a value between 0 and 1 for partial overlap', () => {
    const score = similarity('the economy is growing', 'the economy is shrinking');
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it('ignores short tokens (<= 2 chars)', () => {
    // "is" and "at" should be filtered out
    const score = similarity('inflation is at peak', 'inflation peak');
    expect(score).toBe(1); // "inflation" and "peak" are the only tokens
  });

  it('is case insensitive', () => {
    expect(similarity('Hello World Foo', 'hello world foo')).toBe(1);
  });

  it('strips punctuation', () => {
    expect(similarity('hello, world! foo.', 'hello world foo')).toBe(1);
  });
});

describe('normalizeVerdict', () => {
  it('returns false for false-family ratings', () => {
    expect(normalizeVerdict('False')).toBe('false');
    expect(normalizeVerdict('Pants on Fire')).toBe('false');
    expect(normalizeVerdict('Not True')).toBe('false');
    expect(normalizeVerdict('Debunked')).toBe('false');
    expect(normalizeVerdict('Fake')).toBe('false');
    expect(normalizeVerdict('Incorrect')).toBe('false');
  });

  it('returns misleading for misleading-family ratings', () => {
    expect(normalizeVerdict('Misleading')).toBe('misleading');
    // 'Mostly False' contains 'false' and matches the false check first
    expect(normalizeVerdict('Mostly False')).toBe('false');
    expect(normalizeVerdict('Half True')).toBe('misleading');
    expect(normalizeVerdict('Mixed')).toBe('misleading');
    expect(normalizeVerdict('Out of Context')).toBe('misleading');
    expect(normalizeVerdict('Needs Context')).toBe('misleading');
  });

  it('returns true for true-family ratings', () => {
    expect(normalizeVerdict('True')).toBe('true');
    expect(normalizeVerdict('Mostly True')).toBe('true');
    expect(normalizeVerdict('Correct')).toBe('true');
    expect(normalizeVerdict('Accurate')).toBe('true');
  });

  it('returns unverified for empty or unknown ratings', () => {
    expect(normalizeVerdict('')).toBe('unverified');
    expect(normalizeVerdict('Some Random Rating')).toBe('unverified');
    expect(normalizeVerdict()).toBe('unverified');
  });
});

describe('buildQueryVariants', () => {
  it('returns the normalized claim as the first variant', () => {
    const variants = buildQueryVariants('  The economy   is growing  ');
    expect(variants[0]).toBe('The economy is growing');
  });

  it('returns empty array for empty input', () => {
    expect(buildQueryVariants('')).toHaveLength(0);
    expect(buildQueryVariants('   ')).toHaveLength(0);
  });

  it('truncates long claims to 18 words', () => {
    const long = Array(25).fill('word').join(' ');
    const variants = buildQueryVariants(long);
    expect(variants.length).toBeGreaterThanOrEqual(2);
    expect(variants[1].split(/\s+/).length).toBe(18);
  });

  it('creates focused variant for numeric claims > 12 words', () => {
    const claim = 'The inflation rate is 9.1 percent which is higher than the 7.2 percent recorded last year';
    const variants = buildQueryVariants(claim);
    expect(variants.length).toBeGreaterThanOrEqual(2);
  });

  it('deduplicates identical variants', () => {
    const claim = 'short claim here';
    const variants = buildQueryVariants(claim);
    const unique = new Set(variants);
    expect(variants.length).toBe(unique.size);
  });
});
