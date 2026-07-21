// src/eval/types.ts
//
// Shared types for the Week 2 Day 5 eval harness. Kept in their own file
// (rather than inline in fixtures.ts / judge.ts / runEval.ts) the same way
// src/prompts/types.ts was split out on Day 4 — several files need these
// shapes, and none of them should be the "owner" of a type another file
// depends on.

import type { Classification } from '../schemas/classification.js';

// Confidence isn't graded as an exact float (see docs/week-2-day-5.md's
// "Confidence scoring — exact match is the wrong grader here too" section)
// — ground truth instead labels each fixture with the band its confidence
// SHOULD fall into. Thresholds deliberately match the ones classification
// v2's prompt (src/prompts/classification/v2.ts) already tells the model to
// use, so this harness is measuring the prompt against its own stated goal,
// not an arbitrary external bar.
export type ConfidenceBand = 'high' | 'medium' | 'low';

// One hand-written, ground-truth test case. `text` is plain synthetic
// document text (not a real PDF — see the "Design decision: fixtures are
// text, not real PDF files" section of the day's plan for why), fed directly
// into classifyDocument(), bypassing HTTP and PDF extraction entirely.
export interface Fixture {
  id: string;
  text: string;
  expectedDocumentType: Classification['documentType'];
  expectedConfidenceBand: ConfidenceBand;
  // A short, human-written sentence describing what a CORRECT justification
  // should convey — not a rigid template the model's wording must match
  // (that's exactly the 'exact-match trap' that 'free-text judging' exists to avoid).
  // This is judgeReasoningPointwise's reference answer.
  expectedReasoningSummary: string;
}

// A single call to the judge tool returns one of these — 'pass' means the
// candidate reasoning correctly justifies the classification (even if
// worded differently than expectedReasoningSummary); 'fail' means it
// doesn't, or justifies the WRONG classification.
export interface PointwiseVerdict {
  verdict: 'pass' | 'fail';
  justification: string;
}

// judgeReasoningPairwise runs the underlying tool-use call TWICE — once with
// v1's reasoning shown first, once with v2's shown first — as the
// 'position-bias mitigation' described in the day's plan. `runs` keeps both
// raw verdicts around for debugging ("did the judge actually disagree, or
// did I misread the aggregate result"); `winner` is the AGGREGATE result:
// 'v1' or 'v2' only when both runs agree after accounting for the swap,
// 'tie' if the judge itself said tie both times, and 'inconclusive' if the
// two runs disagreed — itself useful information, not a bug to hide.
export interface PairwiseVerdict {
  winner: 'v1' | 'v2' | 'tie';
  justification: string;
}

export interface PairwiseResult {
  winner: 'v1' | 'v2' | 'tie' | 'inconclusive';
  runs: [PairwiseVerdict, PairwiseVerdict];
}

// Per-prompt-version scoring for a single fixture. `classification` is null
// when classifyDocument itself failed (status: 'classification_failed') —
// that's recorded as both documentTypeCorrect and confidenceBandCorrect
// being false rather than the harness crashing, since a classification
// failure IS a scoring outcome the eval report should surface, not an
// exception that aborts the whole run.
export interface VersionResult {
  version: 'v1' | 'v2';
  classification: Classification | null;
  documentTypeCorrect: boolean;
  confidenceBandCorrect: boolean;
  // null when classification failed outright (nothing to judge) or when the
  // judge call itself failed — kept distinct from a 'fail' verdict, which
  // means the judge ran and concluded the reasoning was wrong.
  reasoningPointwise: PointwiseVerdict | null;
}

// The full result for one fixture, across both prompt versions plus the
// pairwise comparison between them. This is what runEval() returns — an
// array of these, one per fixture — and what scripts/eval.ts both prints as
// a console table and writes verbatim to eval-runs/<timestamp>.json.
export interface EvalResult {
  fixtureId: string;
  v1: VersionResult;
  v2: VersionResult;
  // null when either version's classification failed outright (nothing
  // meaningful to compare) OR when the pairwise judge call itself failed
  // (e.g. after exhausting retries) — runEval() catches that failure rather
  // than letting it abort every fixture still queued behind this one.
  pairwise: PairwiseResult | null;
}
