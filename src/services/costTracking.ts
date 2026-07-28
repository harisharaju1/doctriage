// src/services/costTracking.ts
//
// Week 3 Day 3: pure cost math, deliberately with no repository access and
// no side effects — routes.ts decides WHEN and WHAT to record; this file
// only answers "given this model and this usage, what did it cost." See
// docs/week-3-day-3.md for the full reasoning.
//
// PRICING TABLE — CONFIRM BEFORE TRUSTING /metrics' DOLLAR FIGURES: the
// rates below are illustrative placeholders, not verified against the
// current Anthropic/AWS Bedrock pricing pages for the exact model IDs this
// project uses (see src/config/env.ts's AWS_BEDROCK_EMBEDDING_MODEL_ID,
// AWS_BEDROCK_JUDGE_MODEL_ID, and classifier.ts's MODEL constant). Pricing
// changes, and Bedrock pricing for a model can differ from Anthropic's
// direct-API pricing for the "same" model. The plumbing being correct
// (a real number flows end-to-end and the math is internally consistent)
// is today's actual deliverable — confirming these specific rates is a
// checklist item, not a blocker.

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
