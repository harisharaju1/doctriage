// scripts/eval.ts
//
// The `pnpm eval` CLI entrypoint. Everything scoring-related lives in
// src/eval/runEval.ts (testable, no I/O); this file's only job is to call
// it, aggregate the raw EvalResult[] into summary numbers, print a console
// report, and persist the full result set as JSON. Kept separate the same
// way scripts/ vs src/ is separated elsewhere in this project — CLI/IO
// glue in scripts/, logic in src/.
//
// Run with: pnpm eval
// Calls REAL Claude (Haiku, via Anthropic) and REAL Bedrock (Sonnet judge)
// — costs real (small) money, unlike `pnpm test`, which mocks both.

// Unlike `pnpm test` (vitest.config.ts's setupFiles loads .env for every
// test file) and `pnpm dev` (server.ts imports this itself), a bare `tsx
// scripts/eval.ts` invocation has nothing else that loads .env into
// process.env — without this import, loadEnv() inside judge.ts/classifier.ts
// would see undefined for every required var and crash immediately. Must be
// the first import so .env is populated before any other module (which may
// call loadEnv() at its own module scope, as judge.ts does) is evaluated.
import 'dotenv/config';

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runEval } from '../src/eval/runEval.js';
import type { EvalResult } from '../src/eval/types.js';

// One version's aggregate numbers across every fixture — the console table
// and the "did v2 actually improve on v1" question both boil down to
// comparing two of these.
interface VersionSummary {
  version: 'v1' | 'v2';
  documentTypeAccuracy: number; // 0-1, fraction of fixtures with the correct documentType
  confidenceBandAccuracy: number; // 0-1, fraction with the correct confidence band
  reasoningPassRate: number; // 0-1, fraction whose pointwise judge verdict was 'pass'
}

function summarizeVersion(results: EvalResult[], version: 'v1' | 'v2'): VersionSummary {
  const versionResults = results.map((r) => r[version]);
  const total = versionResults.length;

  const documentTypeAccuracy = versionResults.filter((r) => r.documentTypeCorrect).length / total;
  const confidenceBandAccuracy = versionResults.filter((r) => r.confidenceBandCorrect).length / total;
  // Fixtures where classification itself failed (reasoningPointwise is
  // null) count as a non-pass here, same as a documentType mismatch would —
  // a classification failure is a real failure, not a value to exclude from
  // the denominator.
  const reasoningPassRate =
    versionResults.filter((r) => r.reasoningPointwise?.verdict === 'pass').length / total;

  return { version, documentTypeAccuracy, confidenceBandAccuracy, reasoningPassRate };
}

function summarizePairwise(results: EvalResult[]): { v1Wins: number; v2Wins: number; ties: number; inconclusive: number } {
  const summary = { v1Wins: 0, v2Wins: 0, ties: 0, inconclusive: 0 };
  for (const result of results) {
    if (!result.pairwise) continue;
    if (result.pairwise.winner === 'v1') summary.v1Wins++;
    else if (result.pairwise.winner === 'v2') summary.v2Wins++;
    else if (result.pairwise.winner === 'tie') summary.ties++;
    else summary.inconclusive++;
  }
  return summary;
}

function formatPct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  console.log(`Running eval harness...\n`);
  const results = await runEval();

  console.log('Per-fixture results:\n');
  for (const result of results) {
    const v1Mark = result.v1.documentTypeCorrect && result.v1.confidenceBandCorrect ? 'PASS' : 'FAIL';
    const v2Mark = result.v2.documentTypeCorrect && result.v2.confidenceBandCorrect ? 'PASS' : 'FAIL';
    console.log(`  ${result.fixtureId.padEnd(20)} v1: ${v1Mark}   v2: ${v2Mark}`);
  }

  const v1Summary = summarizeVersion(results, 'v1');
  const v2Summary = summarizeVersion(results, 'v2');
  const pairwise = summarizePairwise(results);

  console.log('\nAggregate accuracy:\n');
  console.log(`  ${'metric'.padEnd(24)}v1        v2`);
  console.log(
    `  ${'documentType exact match'.padEnd(24)}${formatPct(v1Summary.documentTypeAccuracy).padEnd(10)}${formatPct(v2Summary.documentTypeAccuracy)}`,
  );
  console.log(
    `  ${'confidence band match'.padEnd(24)}${formatPct(v1Summary.confidenceBandAccuracy).padEnd(10)}${formatPct(v2Summary.confidenceBandAccuracy)}`,
  );
  console.log(
    `  ${'reasoning pointwise pass'.padEnd(24)}${formatPct(v1Summary.reasoningPassRate).padEnd(10)}${formatPct(v2Summary.reasoningPassRate)}`,
  );

  console.log('\nPairwise (v1 reasoning vs v2 reasoning, same fixture):\n');
  console.log(
    `  v1 wins: ${pairwise.v1Wins}   v2 wins: ${pairwise.v2Wins}   ties: ${pairwise.ties}   inconclusive: ${pairwise.inconclusive}`,
  );

  const outputDir = path.resolve(process.cwd(), 'eval-runs');
  await mkdir(outputDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputPath = path.join(outputDir, `${timestamp}.json`);
  await writeFile(outputPath, JSON.stringify({ results, v1Summary, v2Summary, pairwise }, null, 2));

  console.log(`\nFull results written to ${outputPath}`);
}

main().catch((err: unknown) => {
  console.error('Eval run failed:', err);
  process.exitCode = 1;
});
