import { describe, expect, it } from 'vitest';
import type { CostRecord } from '../repositories/costRepository.js';
import { spentSinceUsd, startOfUtcDay } from '../services/demoBudget.js';

function record(costUsd: number | null, recordedAt: string): CostRecord {
  return {
    documentId: 'doc-1',
    stage: 'classification',
    modelId: 'claude-haiku-4-5-20251001',
    usage: { inputTokens: 0, outputTokens: 0 },
    costUsd,
    recordedAt: new Date(recordedAt),
  };
}

describe('startOfUtcDay', () => {
  it('returns midnight UTC of the same UTC day', () => {
    expect(startOfUtcDay(new Date('2026-10-12T23:59:59.999Z')).toISOString()).toBe('2026-10-12T00:00:00.000Z');
    // 05:00 in India on the 13th is still the 12th in UTC.
    expect(startOfUtcDay(new Date('2026-10-13T05:00:00+05:30')).toISOString()).toBe('2026-10-12T00:00:00.000Z');
  });
});

describe('spentSinceUsd', () => {
  it('sums only records at or after the cutoff, skipping unpriced ones', () => {
    const since = new Date('2026-10-12T00:00:00Z');
    const records = [
      record(0.5, '2026-10-11T23:59:59Z'),
      record(0.25, '2026-10-12T00:00:00Z'),
      record(0.125, '2026-10-12T12:00:00Z'),
      record(null, '2026-10-12T13:00:00Z'),
    ];

    expect(spentSinceUsd(records, since)).toBe(0.375);
  });

  it('is 0 with no records', () => {
    expect(spentSinceUsd([], new Date())).toBe(0);
  });
});
