// src/prompts/classification/v1.ts
//
// This is the ORIGINAL classification prompt, moved out of classifier.ts
// verbatim — not rewritten. That's deliberate: v1 has to be a byte-identical
// extraction of what's been running in production since Week 1, so that
// Day 5's eval harness baseline genuinely reflects "what this project has
// been doing all along," not an accidental behavior change disguised as
// "just moving code into a new file." See src/__tests__/promptRegistry.test.ts
// for the regression test that locks this in.
import type { PromptVersion } from '../types.js';

export const classificationV1: PromptVersion = {
  name: 'classification',
  version: 'v1',
  build: (text: string) =>
    `You are classifying insurance documents. Analyse the following document text and classify it.\n\nDocument text:\n<document>\n${text}\n</document>`,
};
