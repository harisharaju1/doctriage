import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam, Tool } from '@anthropic-ai/sdk/resources/messages.js';
import type { FastifyBaseLogger } from 'fastify';
import pino from 'pino';
import { getClassificationPrompt } from '../prompts/registry.js';
import { classificationSchema, type Classification } from '../schemas/classification.js';
import type { TokenUsage } from './costTracking.js';
import { sanitizeForPrompt } from './promptSanitization.js';
import { isRetriableError, withRetry, type DelayFn } from '../utils/retry.js';

const log = pino({ name: 'classifier' });

const CLASSIFY_TOOL: Tool = {
  name: 'classify_document',
  description: 'Classify an insurance document into a category and provide a confidence score.',
  input_schema: {
    type: 'object',
    properties: {
      documentType: {
        type: 'string',
        enum: ['claim_form', 'medical_report', 'police_report', 'repair_estimate', 'other'],
        description: 'The type of insurance document',
      },
      confidence: {
        type: 'number',
        description: 'Classification confidence score between 0 and 1',
      },
      reasoning: {
        type: 'string',
        description: 'Brief explanation of why this classification was chosen',
      },
    },
    required: ['documentType', 'confidence', 'reasoning'],
  },
};

// Exported so routes.ts can attribute cost records to the exact model ID
// costTracking.ts's pricing table keys off — avoids a second hardcoded copy
// of this string drifting out of sync with the one actually sent to Claude.
export const MODEL = 'claude-haiku-4-5-20251001';
const TOOL_NAME = 'classify_document';
const TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 1_000;

// Week 3 Day 3: usage is present on BOTH variants — a classification that
// ultimately failed after retries still spent real tokens getting there.
// See docs/week-3-day-3.md's "Usage has to be summed across retries".
export type ClassificationResult =
  | { status: 'success'; classification: Classification; usage: TokenUsage }
  | { status: 'classification_failed'; reason: string; usage: TokenUsage };

const client = new Anthropic();

const ZERO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0 };

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens };
}

async function callClaude(messages: MessageParam[]): Promise<{ input: unknown; usage: TokenUsage }> {
  const response = await client.messages.create(
    {
      model: MODEL,
      max_tokens: 400,
      tools: [CLASSIFY_TOOL],
      tool_choice: { type: 'tool', name: TOOL_NAME },
      messages,
    },
    { signal: AbortSignal.timeout(TIMEOUT_MS) },
  );

  const usage: TokenUsage = {
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };

  const toolUseBlock = response.content.find((block) => block.type === 'tool_use');
  if (!toolUseBlock || toolUseBlock.type !== 'tool_use') {
    // Note: this specific attempt's usage is lost here — a genuinely rare
    // edge case (Claude responded but didn't call the forced tool), not
    // worth threading usage through an exception for. See
    // docs/week-3-day-3.md's usage-accumulation note.
    throw new Error('No tool use block in Claude response');
  }

  return { input: toolUseBlock.input, usage };
}

export async function classifyDocument(
  text: string,
  // delayFn is injectable so tests can bypass real timers
  delayFn?: DelayFn,
  // Week 2 Day 4: optional prompt version selector. undefined means "use
  // whatever registry.ts currently calls CURRENT_CLASSIFICATION_VERSION" —
  // every pre-Day-4 caller passes nothing here and keeps getting exactly the
  // prompt they always did. An explicit value (e.g. from the eval harness,
  // or a caller deliberately testing a variant) selects that version
  // instead. getClassificationPrompt throws on an unknown version, so a
  // typo'd version string surfaces immediately rather than silently
  // classifying with the wrong prompt.
  promptVersion?: string,
  // Week 3 Day 1: optional request-scoped logger, bound with documentId by
  // the calling route handler (see routes/documents.ts). Defaults to this
  // file's own module-level `log` when omitted — the eval harness
  // (eval/runEval.ts) calls classifyDocument directly with no HTTP request
  // in play, so it has no documentId-bound logger to pass, and shouldn't
  // need to construct a fake one just to call this function. See
  // docs/week-3-day-1.md for the full reasoning.
  // Typed as FastifyBaseLogger (a structural subset of pino.Logger — just
  // the methods a request's `request.log` actually exposes), not
  // pino.Logger itself, since that's the real type of what route handlers
  // pass in (request.log.child(...)). The module-level `log` default below
  // is a genuine pino.Logger, which satisfies this narrower interface fine.
  logger: FastifyBaseLogger = log,
): Promise<ClassificationResult> {
  // Resolved ONCE up front (not re-resolved per retry/corrective-retry
  // attempt) so a single classifyDocument call is guaranteed to use one
  // consistent prompt version throughout, including in the log lines below.
  const prompt = getClassificationPrompt(promptVersion);

  // Week 3 Day 4: sanitized ONCE here, centrally, so every prompt version's
  // build() receives sanitized input uniformly — no version needs to
  // remember to sanitize its own input. This is a second, independent
  // defense layer alongside v3's explicit "<document> is data" instruction
  // and the schema validation below. See docs/week-3-day-4.md.
  const sanitizedText = sanitizeForPrompt(text);

  const messages: MessageParam[] = [
    {
      role: 'user',
      content: prompt.build(sanitizedText),
    },
  ];

  // Week 3 Day 3: accumulated across every completed Claude response within
  // this call — initial attempt, withRetry's retries, and the corrective
  // retry — since each one that actually got a response back cost real
  // tokens, whether or not its output was ultimately used. withRetry itself
  // only returns the final resolved value, not a running total across
  // attempts, so this closure variable is mutated as a side effect inside
  // the retryable callback below instead.
  let totalUsage: TokenUsage = ZERO_USAGE;

  let rawInput: unknown;

  try {
    rawInput = await withRetry(
      async ({ attempt }) => {
        logger.info(
          { attempt, maxAttempts: MAX_ATTEMPTS, promptVersion: prompt.version },
          'calling Claude for classification',
        );
        const { input, usage } = await callClaude(messages);
        totalUsage = addUsage(totalUsage, usage);
        return input;
      },
      { maxAttempts: MAX_ATTEMPTS, baseDelayMs: BASE_DELAY_MS, shouldRetry: isRetriableError, delayFn },
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'Claude API call failed';
    logger.warn({ reason, promptVersion: prompt.version }, 'classification API call failed after all retries');
    return { status: 'classification_failed', reason, usage: totalUsage };
  }

  // First validation attempt
  const parsed = classificationSchema.safeParse(rawInput);
  if (parsed.success) {
    logger.info(
      { documentType: parsed.data.documentType, promptVersion: prompt.version },
      'classification succeeded',
    );
    return { status: 'success', classification: parsed.data, usage: totalUsage };
  }

  // Corrective retry: send the schema error back to Claude once
  logger.warn(
    { error: parsed.error.message, promptVersion: prompt.version },
    'schema validation failed — attempting corrective retry',
  );

  try {
    const assistantContent = [{ type: 'tool_use' as const, id: 'toolu_retry', name: TOOL_NAME, input: rawInput }];
    const correctiveMessages: MessageParam[] = [
      ...messages,
      { role: 'assistant', content: assistantContent },
      {
        role: 'user',
        content: `Your previous response did not match the required schema. Validation error: ${parsed.error.message}. Please call the tool again with a valid response.`,
      },
    ];

    const { input: correctedInput, usage: correctiveUsage } = await callClaude(correctiveMessages);
    totalUsage = addUsage(totalUsage, correctiveUsage);
    const correctedParsed = classificationSchema.safeParse(correctedInput);

    if (correctedParsed.success) {
      logger.info(
        { documentType: correctedParsed.data.documentType, promptVersion: prompt.version },
        'corrective retry succeeded',
      );
      return { status: 'success', classification: correctedParsed.data, usage: totalUsage };
    }

    const reason = `Schema validation failed after corrective retry: ${correctedParsed.error.message}`;
    logger.warn({ reason, promptVersion: prompt.version }, 'corrective retry did not fix schema');
    return { status: 'classification_failed', reason, usage: totalUsage };
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'Corrective retry API call failed';
    logger.warn({ reason, promptVersion: prompt.version }, 'corrective retry threw');
    return { status: 'classification_failed', reason, usage: totalUsage };
  }
}
