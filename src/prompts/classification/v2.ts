// src/prompts/classification/v2.ts
//
// A deliberate, single, testable change over v1: explicitly instructs the
// model to calibrate its confidence score against genuine ambiguity, rather
// than defaulting to high confidence on documents that could plausibly be
// more than one type. This exists specifically so the prompt-versioning
// system has a real second version to exercise (see docs/week-2-day-4.md,
// "A concrete v2, to prove the system actually works") — not because v2 has
// already been proven better. Whether it actually improves accuracy is
// exactly what Day 5's eval harness measures; until that happens, v2 is
// registered and selectable but NOT promoted to
// registry.ts's CURRENT_CLASSIFICATION_VERSION.
import type { PromptVersion } from '../types.js';

export const classificationV2: PromptVersion = {
  name: 'classification',
  version: 'v2',
  build: (text: string) =>
    `You are classifying insurance documents. Analyse the following document text and classify it.\n\n` +
    `Be calibrated about your confidence score: only report confidence above 0.85 if the document type is ` +
    `unambiguous from its content and structure. If the document could plausibly belong to more than one ` +
    `category, reflect that uncertainty in a lower confidence score rather than defaulting to high confidence.\n\n` +
    `Document text:\n<document>\n${text}\n</document>`,
};
