/**
 * computeCostCents.test.ts — Phase 13 (v0.10.0 — COST-01) unit tests for the
 * pure cost calculator. Asserts the formula derivation in the helper header
 * and the NULL contract for unpriced entries.
 */
import { describe, expect, it } from 'vitest';
import { computeCostCents } from '../../src/cost/computeCostCents.js';
import type { ModelEntry } from '../../src/config/registry.js';

const priced: Pick<ModelEntry, 'pricing'> = {
  pricing: { input_per_1m: 0.10, output_per_1m: 0.30 },
};

const unpriced: Pick<ModelEntry, 'pricing'> = {};

describe('computeCostCents — null contract', () => {
  it('returns null when the entry has no pricing block (local backends)', () => {
    expect(computeCostCents({ entry: unpriced, tokensIn: 100, tokensOut: 50 })).toBeNull();
  });

  it('returns "0.0000" for a priced entry with 0 tokens (cost was zero, not unknown)', () => {
    expect(computeCostCents({ entry: priced, tokensIn: 0, tokensOut: 0 })).toBe('0.0000');
  });

  it('treats undefined tokens as 0 (does NOT return null) for priced entries', () => {
    expect(
      computeCostCents({ entry: priced, tokensIn: undefined, tokensOut: undefined }),
    ).toBe('0.0000');
  });
});

describe('computeCostCents — formula', () => {
  it('100 input tokens at $0.10/1M = 0.001 cents → "0.0010"', () => {
    // (100 × 0.10 + 0 × 0.30) / 10_000 = 10 / 10_000 = 0.001 cents
    expect(computeCostCents({ entry: priced, tokensIn: 100, tokensOut: 0 })).toBe('0.0010');
  });

  it('100 output tokens at $0.30/1M = 0.003 cents → "0.0030"', () => {
    // (0 × 0.10 + 100 × 0.30) / 10_000 = 30 / 10_000 = 0.003 cents
    expect(computeCostCents({ entry: priced, tokensIn: 0, tokensOut: 100 })).toBe('0.0030');
  });

  it('mixed: 100 in + 200 out → 0.001 + 0.006 = 0.007 cents → "0.0070"', () => {
    // (100 × 0.10 + 200 × 0.30) / 10_000 = (10 + 60) / 10_000 = 0.007 cents
    expect(computeCostCents({ entry: priced, tokensIn: 100, tokensOut: 200 })).toBe('0.0070');
  });

  it('large request: 1M in + 500k out at $0.50/$1.50 → "125.0000" cents = $1.25', () => {
    // (1_000_000 × 0.50 + 500_000 × 1.50) / 10_000 = (500_000 + 750_000) / 10_000 = 125.0000 cents
    const expensive: Pick<ModelEntry, 'pricing'> = {
      pricing: { input_per_1m: 0.50, output_per_1m: 1.50 },
    };
    expect(
      computeCostCents({ entry: expensive, tokensIn: 1_000_000, tokensOut: 500_000 }),
    ).toBe('125.0000');
  });

  it('zero pricing on both sides → 0 regardless of tokens', () => {
    const free: Pick<ModelEntry, 'pricing'> = {
      pricing: { input_per_1m: 0, output_per_1m: 0 },
    };
    expect(
      computeCostCents({ entry: free, tokensIn: 100_000, tokensOut: 100_000 }),
    ).toBe('0.0000');
  });

  it('output-only pricing computes correctly', () => {
    const outOnly: Pick<ModelEntry, 'pricing'> = {
      pricing: { input_per_1m: 0, output_per_1m: 2.00 },
    };
    // (0 × 0 + 1000 × 2.00) / 10_000 = 2000 / 10_000 = 0.2 cents → "0.2000"
    expect(computeCostCents({ entry: outOnly, tokensIn: 1000, tokensOut: 1000 })).toBe(
      '0.2000',
    );
  });

  it('non-finite tokens are treated as 0', () => {
    expect(computeCostCents({ entry: priced, tokensIn: NaN, tokensOut: Infinity })).toBe(
      '0.0000',
    );
  });
});
