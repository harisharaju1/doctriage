import { describe, expect, it } from 'vitest';
import { computeCostUsd } from '../services/costTracking.js';

describe('computeCostUsd', () => {
  it('computes cost for a known model from input + output token counts', () => {
    // Haiku pricing: inputPer1K 0.001, outputPer1K 0.005 (see costTracking.ts).
    const cost = computeCostUsd('claude-haiku-4-5-20251001', { inputTokens: 1000, outputTokens: 1000 });

    expect(cost).toBeCloseTo(0.001 + 0.005, 10);
  });

  it('computes zero cost for zero usage', () => {
    const cost = computeCostUsd('claude-haiku-4-5-20251001', { inputTokens: 0, outputTokens: 0 });

    expect(cost).toBe(0);
  });

  it('returns null (not a thrown error) for an unmapped model', () => {
    const cost = computeCostUsd('some-model-not-in-the-pricing-table', { inputTokens: 100, outputTokens: 20 });

    expect(cost).toBeNull();
  });

  it('applies zero output cost for an embedding-shaped usage (outputTokens: 0)', () => {
    const cost = computeCostUsd('amazon.titan-embed-text-v2:0', { inputTokens: 500, outputTokens: 0 });

    // inputPer1K 0.00002 * (500/1000)
    expect(cost).toBeCloseTo(0.00002 * 0.5, 10);
  });
});
