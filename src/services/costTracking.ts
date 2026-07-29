// src/services/costTracking.ts
//
// Week 3 Day 3: pure cost math, deliberately with no repository access and
// no side effects — routes.ts decides WHEN and WHAT to record; this file
// only answers "given this model and this usage, what did it cost." See
// docs/week-3-day-3.md for the full reasoning.
//
// PRICING TABLE — confirmed 2026-07-28 (Week 3 Day 5) against:
//   - Claude Haiku 4.5 (direct Anthropic API, classifier.ts's MODEL
//     constant): platform.claude.com/docs/en/about-claude/pricing —
//     $1/MTok input, $5/MTok output. Matches the rates below exactly.
//   - Claude Sonnet 4.5 via Bedrock (env.AWS_BEDROCK_JUDGE_MODEL_ID's
//     default, a `global.`-prefixed inference profile — see
//     docs/week-2-day-3.md for why global, not regional): confirmed
//     Bedrock's global-endpoint on-demand rate matches Anthropic's direct
//     rate for this model, $3/MTok input, $15/MTok output — worth checking
//     again if this project ever switches to a regional Bedrock endpoint,
//     which carries a 10% premium per Anthropic's own pricing docs.
//   - Titan Text Embeddings V2 (env.AWS_BEDROCK_EMBEDDING_MODEL_ID's
//     default): $0.02/MTok input, no output tokens for an embedding call.
// These rates were ALREADY what Day 3 had seeded as placeholders — this
// confirmation didn't change any number, only turned "illustrative
// placeholder, unverified" into "checked against current published
// pricing." Pricing pages can still drift after today; re-check the exact
// model IDs above if these numbers are ever suspected stale.

import pino from 'pino';

const log = pino({ name: 'costTracking' });

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

interface ModelPricing {
  inputPer1K: number;
  outputPer1K: number;
}

const PRICING: Record<string, ModelPricing> = {
  // Claude Haiku 4.5 — classification (classifier.ts's MODEL constant).
  'claude-haiku-4-5-20251001': { inputPer1K: 0.001, outputPer1K: 0.005 },
  // Titan Text Embeddings V2 — embeddings have no completion, so
  // outputPer1K is always applied to a TokenUsage whose outputTokens is 0.
  'amazon.titan-embed-text-v2:0': { inputPer1K: 0.00002, outputPer1K: 0 },
  // The Bedrock judge model (env.AWS_BEDROCK_JUDGE_MODEL_ID's default).
  'global.anthropic.claude-sonnet-4-5-20250929-v1:0': { inputPer1K: 0.003, outputPer1K: 0.015 },
};

// Returns null (and logs a warning) for an unmapped model ID rather than
// throwing — cost bookkeeping observing a request should never be able to
// break that request. See docs/week-3-day-3.md's "Cost bookkeeping should
// never break the actual request".
export function computeCostUsd(modelId: string, usage: TokenUsage): number | null {
  const pricing = PRICING[modelId];
  if (!pricing) {
    log.warn({ modelId }, 'no pricing entry for model — cost will be recorded as unknown');
    return null;
  }

  const inputCost = (usage.inputTokens / 1000) * pricing.inputPer1K;
  const outputCost = (usage.outputTokens / 1000) * pricing.outputPer1K;
  return inputCost + outputCost;
}
