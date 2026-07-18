// src/__tests__/promptRegistry.test.ts
//
// Covers the two things that actually matter for the prompt-versioning
// system to be trustworthy: (1) v1 is a byte-identical extraction of the
// original inline template that used to live in classifier.ts — a
// regression guard proving today's refactor is a pure move, not a rewrite
// that would quietly invalidate Day 5's eval baseline — and (2) version
// resolution behaves correctly for the default case, an explicit valid
// version, and an explicit invalid version.
import { describe, expect, it } from 'vitest';
import { CURRENT_CLASSIFICATION_VERSION, getClassificationPrompt } from '../prompts/registry.js';

describe('getClassificationPrompt', () => {
  it('returns v1 when no version is specified', () => {
    const prompt = getClassificationPrompt();
    expect(prompt.version).toBe('v1');
    expect(prompt.version).toBe(CURRENT_CLASSIFICATION_VERSION);
  });

  it('returns v2 when explicitly requested', () => {
    const prompt = getClassificationPrompt('v2');
    expect(prompt.version).toBe('v2');
  });

  it('throws a clear, named error for an unknown version', () => {
    expect(() => getClassificationPrompt('v3')).toThrow(/Unknown classification prompt version: "v3"/);
  });

  it('v1.build produces byte-identical output to the original inline template', () => {
    const text = 'Some extracted document text.';
    const prompt = getClassificationPrompt('v1');

    // This is the ORIGINAL inline string that lived in classifier.ts before
    // Week 2 Day 4 — copied here verbatim as the regression baseline, not
    // re-derived from v1.ts itself (that would just be comparing the file
    // to itself and could never catch an accidental wording change).
    const originalTemplate = `You are classifying insurance documents. Analyse the following document text and classify it.\n\nDocument text:\n<document>\n${text}\n</document>`;

    expect(prompt.build(text)).toBe(originalTemplate);
  });

  it('v2 differs from v1 for the same input text', () => {
    const text = 'Some extracted document text.';
    expect(getClassificationPrompt('v1').build(text)).not.toBe(getClassificationPrompt('v2').build(text));
  });
});
