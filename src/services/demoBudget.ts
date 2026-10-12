// src/services/demoBudget.ts
//
// Week 4: the live demo is public, and every classify/embed/query call
// spends real money. The daily budget is the hard backstop behind the
// per-IP rate limit (src/plugins/rateLimit.ts): rate limiting slows one
// visitor down, but only a spend ceiling bounds what MANY visitors (or one
// visitor rotating IPs) can cost in a day.
//
// Computed from the CostRecords the routes already write for /metrics,
// rather than a separate counter — one source of truth for "what has this
// server spent", including failed calls (which are billed too). Records
// with costUsd: null (unmapped model) can't be counted in dollars; they're
// excluded here exactly as /metrics excludes them.
//
// Known limitation: CostRepository is in-memory, so the day's total resets
// if the process restarts. The provider-side spend limits (Anthropic
// Console, AWS Budgets) are what still hold in that case.

import type { CostRecord } from '../repositories/costRepository.js';

export function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function spentSinceUsd(records: readonly CostRecord[], since: Date): number {
  let total = 0;
  for (const record of records) {
    if (record.recordedAt >= since && record.costUsd !== null) {
      total += record.costUsd;
    }
  }
  return total;
}
