// src/__tests__/judge.test.ts
//
// Mirrors classifier.test.ts's pattern: mock the SDK client ONE LEVEL DEEPER
// than judge.ts itself (the AWS Bedrock runtime client, not judge.ts's own
// exported functions), so judgeReasoningPointwise/judgeReasoningPairwise's
// REAL logic runs — prompt building, tool-use extraction, Zod validation,
// and (for pairwise) the swap-and-compare position-bias logic — against a
// fake Bedrock response this file controls.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSend = vi.fn();

// judge.ts does `const client = new BedrockRuntimeClient({...})` at module
// load time, same reasoning as classifier.test.ts's Anthropic mock: the
// mock factory must be in place before judge.ts is imported, and the fake
// constructor must be a real `function` (not an arrow function) since
// BedrockRuntimeClient is invoked with `new`.
vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: vi.fn().mockImplementation(function FakeBedrockRuntimeClient() {
    return { send: mockSend };
  }),
  // InvokeModelCommand is just a plain data container in judge.ts's usage
  // (constructed, then handed straight to client.send()) — echoing the
  // input back out is enough for mockSend to inspect what was requested,
  // without needing to model the real AWS SDK command class. Must be a real
  // `function` (not an arrow function), same reasoning as
  // BedrockRuntimeClient above and as classifier.test.ts's Anthropic mock —
  // judge.ts calls `new InvokeModelCommand(...)`, and `new` on an arrow
  // function throws "is not a constructor". Returning the input object from
  // a constructor function makes `new` resolve to that returned object.
  InvokeModelCommand: vi.fn().mockImplementation(function FakeInvokeModelCommand(input: unknown) {
    return input;
  }),
}));

// Builds a fake Bedrock InvokeModel response body shaped like the real
// Anthropic-on-Bedrock response: a JSON object with a `content` array
// containing a tool_use block. response.body must be raw bytes
// (Uint8Array), matching what the real AWS SDK returns and what
// callBedrockJudge() decodes with TextDecoder.
function bedrockToolResponse(input: unknown) {
  return {
    body: new TextEncoder().encode(JSON.stringify({ content: [{ type: 'tool_use', input }] })),
  };
}

describe('judgeReasoningPointwise', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it('parses a pass verdict from the Bedrock response', async () => {
    const { judgeReasoningPointwise } = await import('../eval/judge.js');
    mockSend.mockResolvedValue(bedrockToolResponse({ verdict: 'pass', justification: 'Correctly identifies the document type.' }));

    const result = await judgeReasoningPointwise('some document text', 'candidate reasoning', 'expected summary');

    expect(result).toEqual({ verdict: 'pass', justification: 'Correctly identifies the document type.' });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('sends a request that forces the judge_pointwise tool and includes the delimited content', async () => {
    const { judgeReasoningPointwise } = await import('../eval/judge.js');
    mockSend.mockResolvedValue(bedrockToolResponse({ verdict: 'pass', justification: 'ok' }));

    await judgeReasoningPointwise('DOC TEXT', 'CANDIDATE', 'EXPECTED');

    // mockSend's first argument is the InvokeModelCommand input (echoed
    // straight through by the mocked InvokeModelCommand above); its `body`
    // field is the raw encoded JSON request payload, same as the real SDK.
    const sentInput = mockSend.mock.calls[0]![0] as { modelId: string; body: Uint8Array };
    const sentBody = JSON.parse(new TextDecoder().decode(sentInput.body)) as {
      tool_choice: { type: string; name: string };
      messages: Array<{ content: string }>;
    };

    expect(sentBody.tool_choice).toEqual({ type: 'tool', name: 'judge_pointwise' });
    expect(sentBody.messages[0]!.content).toContain('<document>\nDOC TEXT\n</document>');
    expect(sentBody.messages[0]!.content).toContain('<candidate_reasoning>\nCANDIDATE\n</candidate_reasoning>');
    expect(sentBody.messages[0]!.content).toContain('<expected>\nEXPECTED\n</expected>');
  });
});

describe('judgeReasoningPairwise', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it('makes exactly two calls (swapped order) and reports the agreed winner', async () => {
    const { judgeReasoningPairwise } = await import('../eval/judge.js');

    // Both calls report the SAME reasoning as the winner once the swap is
    // accounted for: run 1 (v1=A, v2=B) says 'a' wins → v1; run 2 (v2=A,
    // v1=B) says 'b' wins → v1 again after un-swapping. Genuine agreement.
    mockSend
      .mockResolvedValueOnce(bedrockToolResponse({ winner: 'a', justification: 'A is clearer.' }))
      .mockResolvedValueOnce(bedrockToolResponse({ winner: 'b', justification: 'B (still v1) is clearer.' }));

    const result = await judgeReasoningPairwise('doc text', 'v1 reasoning', 'v2 reasoning');

    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(result.winner).toBe('v1');
    expect(result.runs).toHaveLength(2);
  });

  it("returns 'inconclusive' when the two swapped runs disagree", async () => {
    const { judgeReasoningPairwise } = await import('../eval/judge.js');

    // Run 1 (v1=A, v2=B) says 'a' wins → v1. Run 2 (v2=A, v1=B) ALSO says
    // 'a' wins → but this time 'a' is v2, so after un-swapping that's a v2
    // win. The two runs disagree once corrected for position — a real
    // position-bias signal, not a coincidence to paper over.
    mockSend
      .mockResolvedValueOnce(bedrockToolResponse({ winner: 'a', justification: 'first run' }))
      .mockResolvedValueOnce(bedrockToolResponse({ winner: 'a', justification: 'second run' }));

    const result = await judgeReasoningPairwise('doc text', 'v1 reasoning', 'v2 reasoning');

    expect(result.winner).toBe('inconclusive');
  });

  it('the second call swaps the reasoning order relative to the first', async () => {
    const { judgeReasoningPairwise } = await import('../eval/judge.js');
    mockSend.mockResolvedValue(bedrockToolResponse({ winner: 'tie', justification: 'equal' }));

    await judgeReasoningPairwise('doc text', 'REASONING_ONE', 'REASONING_TWO');

    const firstCallBody = JSON.parse(
      new TextDecoder().decode((mockSend.mock.calls[0]![0] as { body: Uint8Array }).body),
    ) as { messages: Array<{ content: string }> };
    const secondCallBody = JSON.parse(
      new TextDecoder().decode((mockSend.mock.calls[1]![0] as { body: Uint8Array }).body),
    ) as { messages: Array<{ content: string }> };

    // First call: REASONING_ONE in the A slot. Second call: REASONING_TWO in
    // the A slot — confirming the swap actually happened, not just that two
    // calls were made.
    expect(firstCallBody.messages[0]!.content.indexOf('REASONING_ONE')).toBeLessThan(
      firstCallBody.messages[0]!.content.indexOf('REASONING_TWO'),
    );
    expect(secondCallBody.messages[0]!.content.indexOf('REASONING_TWO')).toBeLessThan(
      secondCallBody.messages[0]!.content.indexOf('REASONING_ONE'),
    );
  });
});
