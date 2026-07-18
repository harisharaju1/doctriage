// src/__tests__/classifier.test.ts
//
// classifier.ts has no dedicated test file before today — its behavior was
// only exercised indirectly through documents.routes.test.ts, which mocks
// the ENTIRE classifier module (so it never actually runs classifyDocument's
// internals). Week 2 Day 4 adds new internal behavior — prompt version
// resolution — that specifically needs classifyDocument itself under test,
// so this file mocks one level deeper: the Anthropic SDK client, not
// classifier.ts. That lets classifyDocument's real logic run (prompt
// selection, schema validation, corrective retry) against a fake Claude
// response we control.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockCreate = vi.fn();

// classifier.ts does `const client = new Anthropic();` at module load time,
// so the mock has to be in place before classifier.ts is imported. Mocking
// the whole module and replacing its default export with a fake constructor
// that always returns an object exposing `messages.create` is the standard
// vitest pattern for this — see vi.mock's hoisting behavior (this factory
// runs before any import statements below it).
vi.mock('@anthropic-ai/sdk', () => ({
  // Must be a real `function` (not an arrow function) — classifier.ts calls
  // `new Anthropic()`, and `new` on an arrow function throws
  // "is not a constructor". A plain function used as a constructor works
  // fine here since we never rely on `this`/prototype behavior beyond
  // returning the fake client shape.
  default: vi.fn().mockImplementation(function FakeAnthropic() {
    return { messages: { create: mockCreate } };
  }),
}));

function claudeToolResponse(input: unknown) {
  return {
    content: [{ type: 'tool_use', id: 'toolu_1', name: 'classify_document', input }],
  };
}

const VALID_CLASSIFICATION = {
  documentType: 'claim_form',
  confidence: 0.9,
  reasoning: 'looks like a claim form',
};

describe('classifyDocument', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('uses the v1 prompt by default', async () => {
    const { classifyDocument } = await import('../services/classifier.js');
    mockCreate.mockResolvedValue(claudeToolResponse(VALID_CLASSIFICATION));

    await classifyDocument('some document text');

    const sentMessages = mockCreate.mock.calls[0]![0].messages;
    // v1's known wording — if this call were built from v2 instead, this
    // exact phrase ("Analyse the following document text and classify it.")
    // would still be present too, so we assert on v2's DISTINGUISHING
    // phrase's absence instead, to actually prove v1 (not just "a" prompt)
    // was used.
    expect(sentMessages[0].content).not.toContain('Be calibrated about your confidence score');
  });

  it('uses the v2 prompt when explicitly requested', async () => {
    const { classifyDocument } = await import('../services/classifier.js');
    mockCreate.mockResolvedValue(claudeToolResponse(VALID_CLASSIFICATION));

    await classifyDocument('some document text', undefined, 'v2');

    const sentMessages = mockCreate.mock.calls[0]![0].messages;
    expect(sentMessages[0].content).toContain('Be calibrated about your confidence score');
  });

  it('rejects (throws, does not silently fall back to v1) for an unknown prompt version', async () => {
    const { classifyDocument } = await import('../services/classifier.js');

    // getClassificationPrompt throws synchronously before any network call
    // is made — confirmed here by asserting mockCreate was never invoked,
    // not just that the promise rejects.
    await expect(classifyDocument('some document text', undefined, 'v3')).rejects.toThrow(
      /Unknown classification prompt version: "v3"/,
    );
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('succeeds and returns the classification on a valid first response', async () => {
    const { classifyDocument } = await import('../services/classifier.js');
    mockCreate.mockResolvedValue(claudeToolResponse(VALID_CLASSIFICATION));

    const result = await classifyDocument('some document text');

    expect(result).toEqual({ status: 'success', classification: VALID_CLASSIFICATION });
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});
