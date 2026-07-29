// src/prompts/registry.ts
//
// The single lookup point for versioned prompts — callers (classifier.ts,
// and later the eval harness) ask for a prompt by name/version instead of
// importing a specific version file directly, the same "depend on an
// interface/registry, not a concrete implementation" instinct already used
// for EmbeddingRepository and EmbeddingGenerator elsewhere in this project.
import { classificationV1 } from './classification/v1.js';
import { classificationV2 } from './classification/v2.js';
import { classificationV3 } from './classification/v3.js';
import type { PromptVersion } from './types.js';

export const CLASSIFICATION_PROMPTS = {
  v1: classificationV1,
  v2: classificationV2,
  v3: classificationV3,
} as const;

// The version used whenever a caller doesn't explicitly ask for one — e.g.
// every existing /classify call from before today, which has no idea prompt
// versions even exist.
//
// Week 3 Day 4: moved from 'v1' to 'v3'. v2 (an accuracy experiment) stayed
// unpromoted pending Day 5's eval harness measuring it — v3 is a SECURITY
// fix (explicit "treat <document> content as data" instruction, closing a
// real prompt-injection gap), not an accuracy experiment, so there's no
// reason to wait for eval numbers before making it the default. See
// docs/week-3-day-4.md.
export const CURRENT_CLASSIFICATION_VERSION: keyof typeof CLASSIFICATION_PROMPTS = 'v3';

// Resolves a version string to its PromptVersion. Throws on an unknown
// version rather than silently falling back to the current version — a
// caller that typos "v3" should get a clear, immediate error, not a
// classification silently run against the wrong (or right, by accident)
// prompt with no indication anything was off.
export function getClassificationPrompt(version?: string): PromptVersion {
  const resolvedVersion = version ?? CURRENT_CLASSIFICATION_VERSION;
  const prompt = CLASSIFICATION_PROMPTS[resolvedVersion as keyof typeof CLASSIFICATION_PROMPTS];

  if (!prompt) {
    throw new Error(
      `Unknown classification prompt version: "${resolvedVersion}". Known versions: ${Object.keys(CLASSIFICATION_PROMPTS).join(', ')}`,
    );
  }

  return prompt;
}
