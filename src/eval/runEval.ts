// src/eval/runEval.ts
//
// Orchestration only — no printing, no file I/O. That's deliberately
// scripts/eval.ts's job, not this module's, so runEval() itself stays
// testable in isolation (src/__tests__/runEval.test.ts calls it directly
// with classifyDocument/judge functions mocked and asserts on the returned
// EvalResult[], with nothing printed or written to disk to intercept).
//
// For each fixture: runs classification under BOTH prompt versions (v1 and
// v2, via Day 4's promptVersion parameter on classifyDocument), scores the
// structured fields (documentType exact match, confidence band match)
// against ground truth, judges each version's `reasoning` pointwise against
// the fixture's expectedReasoningSummary, and — when both versions actually
// produced a classification — runs one pairwise comparison between the two
// versions' reasoning.

import pino from 'pino';
import { classifyDocument } from '../services/classifier.js';
import { EVAL_FIXTURES } from './fixtures.js';
import { judgeReasoningPairwise, judgeReasoningPointwise } from './judge.js';
import type { ConfidenceBand, EvalResult, Fixture, VersionResult } from './types.js';

const log = pino({ name: 'runEval' });

// Reuses classification v2's own stated calibration thresholds (see
// src/prompts/classification/v2.ts) — the harness measures the prompt
// against its own stated goal rather than an arbitrary external bar.
function confidenceToBand(confidence: number): ConfidenceBand {
  if (confidence >= 0.85) return 'high';
  if (confidence >= 0.6) return 'medium';
  return 'low';
}

// Runs one prompt version against one fixture: classification + structured
// scoring + pointwise reasoning judgement. Returns both the VersionResult
// (for the caller's scoring/reporting) and the raw Classification (or null),
// since runEvalForFixture() below needs the raw classification to run the
// pairwise comparison across both versions.
async function runVersion(
  fixture: Fixture,
  version: 'v1' | 'v2',
): Promise<VersionResult> {
  const result = await classifyDocument(fixture.text, undefined, version);

  if (result.status !== 'success') {
    // A classification failure IS a scoring outcome, not an exception that
    // should abort the whole eval run — recorded as both structured checks
    // failing and nothing to judge, same as any other "wrong answer".
    return {
      version,
      classification: null,
      documentTypeCorrect: false,
      confidenceBandCorrect: false,
      reasoningPointwise: null,
    };
  }

  const { classification } = result;
  const documentTypeCorrect = classification.documentType === fixture.expectedDocumentType;
  const confidenceBandCorrect = confidenceToBand(classification.confidence) === fixture.expectedConfidenceBand;

  // Classification succeeding doesn't guarantee the JUDGE call does — a
  // Bedrock call can still throw after exhausting withRetry's attempts
  // (rate limits, the AWS Marketplace-subscription-propagation flakiness
  // observed live while wiring this up, etc.). Before this try/catch, a
  // single judge failure anywhere threw all the way out of runEval()'s
  // fixture loop and silently discarded every fixture already scored — a
  // 20-fixture run that failed on fixture 7 lost fixtures 1-6's real,
  // already-paid-for API results. Catching here means a judge failure is
  // recorded as "nothing to judge" (reasoningPointwise: null — the SAME
  // shape a failed classification already produces, per this field's type
  // comment in types.ts) for just this one version, not a fatal error for
  // the whole run.
  let reasoningPointwise: VersionResult['reasoningPointwise'] = null;
  try {
    reasoningPointwise = await judgeReasoningPointwise(
      fixture.text,
      classification.reasoning,
      fixture.expectedReasoningSummary,
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'pointwise judge call failed';
    log.warn({ fixtureId: fixture.id, version, reason }, 'pointwise judge call failed — recording as unjudged');
  }

  return {
    version,
    classification,
    documentTypeCorrect,
    confidenceBandCorrect,
    reasoningPointwise,
  };
}

async function runEvalForFixture(fixture: Fixture): Promise<EvalResult> {
  const [v1, v2] = await Promise.all([runVersion(fixture, 'v1'), runVersion(fixture, 'v2')]);

  // Same reasoning as the pointwise catch above: don't let a pairwise judge
  // failure abort fixtures that haven't run yet. pairwise being null already
  // means "nothing to compare" for the classification-failed case (see this
  // field's comment in types.ts) — a judge-call failure reuses that same
  // meaning rather than introducing a separate error shape.
  let pairwise: EvalResult['pairwise'] = null;
  if (v1.classification && v2.classification) {
    try {
      pairwise = await judgeReasoningPairwise(fixture.text, v1.classification.reasoning, v2.classification.reasoning);
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'pairwise judge call failed';
      log.warn({ fixtureId: fixture.id, reason }, 'pairwise judge call failed — recording as unjudged');
    }
  }

  return { fixtureId: fixture.id, v1, v2, pairwise };
}

// fixtures defaults to the full hand-written set (EVAL_FIXTURES) but is
// injectable — the same pattern classifyDocument's own delayFn parameter
// established on Day 4 — so tests can pass a tiny 2-3 fixture in-memory set
// instead of running (and paying for) the full 20-fixture eval.
export async function runEval(fixtures: Fixture[] = EVAL_FIXTURES): Promise<EvalResult[]> {
  const results: EvalResult[] = [];
  // Sequential, not Promise.all across fixtures — deliberate: this is an
  // offline batch script run rarely (via `pnpm eval`), not a latency-
  // sensitive path, and running fixtures sequentially keeps Bedrock/Claude
  // request volume predictable rather than bursting 20 fixtures' worth of
  // concurrent calls against both providers' rate limits at once.
  for (const fixture of fixtures) {
    results.push(await runEvalForFixture(fixture));
  }
  return results;
}
