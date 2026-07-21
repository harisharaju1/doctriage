// src/__tests__/runEval.test.ts
//
// Unlike judge.test.ts (which mocks one level deeper to exercise judge.ts's
// real logic), this file mocks classifyDocument AND the judge functions
// directly — runEval()'s job is orchestration and scoring, not classifying
// or judging, so those two collaborators are faked outright. This keeps the
// test suite honest about "zero real API credentials needed" (Day 3's rule,
// reused every day since): no Anthropic key, no AWS credentials touched.
//
// A tiny 2-3 fixture in-memory set is passed directly to runEval() (its
// `fixtures` parameter defaults to the full 20-fixture EVAL_FIXTURES, but is
// injectable for exactly this reason) rather than mocking fixtures.ts —
// simpler, and proves the injection seam actually works.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Classification } from '../schemas/classification.js';
import type { ClassificationResult } from '../services/classifier.js';
import type { Fixture, PairwiseResult, PointwiseVerdict } from '../eval/types.js';

const mockClassifyDocument = vi.fn();
const mockJudgeReasoningPointwise = vi.fn();
const mockJudgeReasoningPairwise = vi.fn();

vi.mock('../services/classifier.js', () => ({
  classifyDocument: mockClassifyDocument,
}));

vi.mock('../eval/judge.js', () => ({
  judgeReasoningPointwise: mockJudgeReasoningPointwise,
  judgeReasoningPairwise: mockJudgeReasoningPairwise,
}));

const FIXTURES: Fixture[] = [
  {
    id: 'fixture-a',
    text: 'document text a',
    expectedDocumentType: 'claim_form',
    expectedConfidenceBand: 'high',
    expectedReasoningSummary: 'expected summary a',
  },
  {
    id: 'fixture-b',
    text: 'document text b',
    expectedDocumentType: 'medical_report',
    expectedConfidenceBand: 'low',
    expectedReasoningSummary: 'expected summary b',
  },
];

function successResult(overrides: Partial<Classification>): ClassificationResult {
  return {
    status: 'success',
    classification: {
      documentType: 'claim_form',
      confidence: 0.9,
      reasoning: 'default reasoning',
      ...overrides,
    },
  };
}

const PASS_VERDICT: PointwiseVerdict = { verdict: 'pass', justification: 'looks right' };
const TIE_PAIRWISE: PairwiseResult = {
  winner: 'tie',
  runs: [
    { winner: 'tie', justification: 'run 1' },
    { winner: 'tie', justification: 'run 2' },
  ],
};

describe('runEval', () => {
  beforeEach(() => {
    mockClassifyDocument.mockReset();
    mockJudgeReasoningPointwise.mockReset();
    mockJudgeReasoningPairwise.mockReset();
  });

  it('scores documentType exact match and confidence band match correctly for both versions', async () => {
    const { runEval } = await import('../eval/runEval.js');

    // fixture-a: v1 gets it right (correct type, high-band confidence), v2
    // gets the documentType wrong.
    mockClassifyDocument.mockImplementation((_text: string, _delayFn: unknown, version: string) => {
      if (version === 'v1') return Promise.resolve(successResult({ documentType: 'claim_form', confidence: 0.95 }));
      return Promise.resolve(successResult({ documentType: 'other', confidence: 0.95 }));
    });
    mockJudgeReasoningPointwise.mockResolvedValue(PASS_VERDICT);
    mockJudgeReasoningPairwise.mockResolvedValue(TIE_PAIRWISE);

    const [resultA] = await runEval([FIXTURES[0]!]);

    expect(resultA!.v1.documentTypeCorrect).toBe(true);
    expect(resultA!.v1.confidenceBandCorrect).toBe(true); // 0.95 -> 'high', fixture-a expects 'high'
    expect(resultA!.v2.documentTypeCorrect).toBe(false); // 'other' !== 'claim_form'
  });

  it('checks confidence against the expected BAND, not an exact float', async () => {
    const { runEval } = await import('../eval/runEval.js');

    // fixture-b expects 'low' band (< 0.6). 0.5 should count as correct even
    // though it's not any specific "expected" float.
    mockClassifyDocument.mockResolvedValue(successResult({ documentType: 'medical_report', confidence: 0.5 }));
    mockJudgeReasoningPointwise.mockResolvedValue(PASS_VERDICT);
    mockJudgeReasoningPairwise.mockResolvedValue(TIE_PAIRWISE);

    const [resultB] = await runEval([FIXTURES[1]!]);

    expect(resultB!.v1.confidenceBandCorrect).toBe(true);
    expect(resultB!.v2.confidenceBandCorrect).toBe(true);
  });

  it('records a classification failure as a scoring outcome, not a thrown error, and skips judging', async () => {
    const { runEval } = await import('../eval/runEval.js');

    mockClassifyDocument.mockImplementation((_text: string, _delayFn: unknown, version: string) => {
      if (version === 'v1') return Promise.resolve({ status: 'classification_failed', reason: 'Claude API call failed' });
      return Promise.resolve(successResult({}));
    });
    mockJudgeReasoningPointwise.mockResolvedValue(PASS_VERDICT);

    const [result] = await runEval([FIXTURES[0]!]);

    expect(result!.v1.classification).toBeNull();
    expect(result!.v1.documentTypeCorrect).toBe(false);
    expect(result!.v1.confidenceBandCorrect).toBe(false);
    expect(result!.v1.reasoningPointwise).toBeNull();
    // Only v2 succeeded, so no pointwise call should have happened for v1,
    // and pairwise (which needs BOTH versions) should not have been called
    // at all — nothing meaningful to compare against a failed classification.
    expect(mockJudgeReasoningPointwise).toHaveBeenCalledTimes(1);
    expect(mockJudgeReasoningPairwise).not.toHaveBeenCalled();
    expect(result!.pairwise).toBeNull();
  });

  it('calls judgeReasoningPairwise once per fixture when both versions succeed', async () => {
    const { runEval } = await import('../eval/runEval.js');

    mockClassifyDocument.mockResolvedValue(successResult({}));
    mockJudgeReasoningPointwise.mockResolvedValue(PASS_VERDICT);
    mockJudgeReasoningPairwise.mockResolvedValue(TIE_PAIRWISE);

    const results = await runEval(FIXTURES);

    expect(mockJudgeReasoningPairwise).toHaveBeenCalledTimes(FIXTURES.length);
    expect(results).toHaveLength(FIXTURES.length);
    expect(results[0]!.pairwise).toEqual(TIE_PAIRWISE);
  });

  // Added after a real pnpm eval run against live Bedrock lost several
  // already-completed (and already-paid-for) fixtures' worth of results
  // when a later fixture's judge call threw — the whole runEval() loop
  // aborted instead of returning what had already succeeded. This test
  // locks in the fix: a judge failure on ONE fixture must not prevent the
  // NEXT fixture from running, and must not crash the run.
  it('does not abort the whole run when a pointwise judge call throws for one fixture', async () => {
    const { runEval } = await import('../eval/runEval.js');

    mockClassifyDocument.mockResolvedValue(successResult({}));
    // fixture-a's pointwise judge call throws (simulating an exhausted-retry
    // Bedrock failure); fixture-b's succeeds normally.
    mockJudgeReasoningPointwise.mockImplementation((_doc: string, _candidate: string, expectedSummary: string) => {
      if (expectedSummary === FIXTURES[0]!.expectedReasoningSummary) {
        return Promise.reject(new Error('AccessDeniedException: AWS Marketplace subscription ...'));
      }
      return Promise.resolve(PASS_VERDICT);
    });
    mockJudgeReasoningPairwise.mockResolvedValue(TIE_PAIRWISE);

    const results = await runEval(FIXTURES);

    // Both fixtures are still present in the results — fixture-b was NOT
    // dropped just because fixture-a's judge call blew up.
    expect(results).toHaveLength(2);
    expect(results[0]!.fixtureId).toBe('fixture-a');
    expect(results[0]!.v1.reasoningPointwise).toBeNull(); // recorded as unjudged, not thrown
    expect(results[1]!.fixtureId).toBe('fixture-b');
    expect(results[1]!.v1.reasoningPointwise).toEqual(PASS_VERDICT); // unaffected by fixture-a's failure
  });

  it('does not abort the run when a pairwise judge call throws, and records pairwise as null', async () => {
    const { runEval } = await import('../eval/runEval.js');

    mockClassifyDocument.mockResolvedValue(successResult({}));
    mockJudgeReasoningPointwise.mockResolvedValue(PASS_VERDICT);
    mockJudgeReasoningPairwise.mockRejectedValue(new Error('ThrottlingException'));

    const results = await runEval([FIXTURES[0]!]);

    expect(results).toHaveLength(1);
    expect(results[0]!.pairwise).toBeNull();
    // The rest of the fixture's scoring is untouched by the pairwise failure.
    expect(results[0]!.v1.documentTypeCorrect).toBe(true);
  });
});
