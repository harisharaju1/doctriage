// src/prompts/types.ts
//
// Shared shape for every versioned prompt in this project. As of Week 2 Day
// 4, "classification" is the only prompt that exists — see
// docs/week-2-day-4.md for why (extraction.ts is pure PDF parsing, no LLM
// call, no prompt to version). This type is kept generic (a `name` +
// `version` for identification/logging, and a `build` function that turns
// runtime data into the final prompt string) specifically so a future
// extraction or LLM-judge prompt (Day 5's stretch goal) can reuse it
// unchanged — but nothing beyond that is speculatively added today.
export interface PromptVersion {
  name: string;
  version: string;
  // Takes the raw document text and returns the fully-built prompt string.
  // A function rather than a static string/template file because the
  // classification prompt is built FROM data (the document text is
  // interpolated in) — TypeScript template literals already give us that
  // for free, without needing a separate templating syntax/engine for a
  // `.txt`-file-based approach to handle the same substitution.
  build: (text: string) => string;
}
