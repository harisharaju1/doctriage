import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam, Tool } from '@anthropic-ai/sdk/resources/messages.js';
import pino from 'pino';
import { classificationSchema, type Classification } from '../schemas/classification.js';
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

const MODEL = 'claude-haiku-4-5-20251001';
const TOOL_NAME = 'classify_document';
const TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 1_000;

export type ClassificationResult =
  | { status: 'success'; classification: Classification }
  | { status: 'classification_failed'; reason: string };

const client = new Anthropic();

async function callClaude(messages: MessageParam[]): Promise<unknown> {
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

  const toolUseBlock = response.content.find((block) => block.type === 'tool_use');
  if (!toolUseBlock || toolUseBlock.type !== 'tool_use') {
    throw new Error('No tool use block in Claude response');
  }

  return toolUseBlock.input;
}

export async function classifyDocument(
  text: string,
  // delayFn is injectable so tests can bypass real timers
  delayFn?: DelayFn,
): Promise<ClassificationResult> {
  const messages: MessageParam[] = [
    {
      role: 'user',
      content: `You are classifying insurance documents. Analyse the following document text and classify it.\n\nDocument text:\n<document>\n${text}\n</document>`,
    },
  ];

  let rawInput: unknown;

  try {
    rawInput = await withRetry(
      async ({ attempt }) => {
        log.info({ attempt, maxAttempts: MAX_ATTEMPTS }, 'calling Claude for classification');
        return callClaude(messages);
      },
      { maxAttempts: MAX_ATTEMPTS, baseDelayMs: BASE_DELAY_MS, shouldRetry: isRetriableError, delayFn },
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'Claude API call failed';
    log.warn({ reason }, 'classification API call failed after all retries');
    return { status: 'classification_failed', reason };
  }

  // First validation attempt
  const parsed = classificationSchema.safeParse(rawInput);
  if (parsed.success) {
    log.info({ documentType: parsed.data.documentType }, 'classification succeeded');
    return { status: 'success', classification: parsed.data };
  }

  // Corrective retry: send the schema error back to Claude once
  log.warn({ error: parsed.error.message }, 'schema validation failed — attempting corrective retry');

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

    const correctedInput = await callClaude(correctiveMessages);
    const correctedParsed = classificationSchema.safeParse(correctedInput);

    if (correctedParsed.success) {
      log.info({ documentType: correctedParsed.data.documentType }, 'corrective retry succeeded');
      return { status: 'success', classification: correctedParsed.data };
    }

    const reason = `Schema validation failed after corrective retry: ${correctedParsed.error.message}`;
    log.warn({ reason }, 'corrective retry did not fix schema');
    return { status: 'classification_failed', reason };
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'Corrective retry API call failed';
    log.warn({ reason }, 'corrective retry threw');
    return { status: 'classification_failed', reason };
  }
}
