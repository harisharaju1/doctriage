import Anthropic from '@anthropic-ai/sdk';
import type { Tool } from '@anthropic-ai/sdk/resources/messages.js';
import { classificationSchema, type Classification } from '../schemas/classification.js';

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

export type ClassificationResult =
  | { status: 'success'; classification: Classification }
  | { status: 'classification_failed'; reason: string };

const client = new Anthropic();

export async function classifyDocument(text: string): Promise<ClassificationResult> {
  let rawInput: unknown;

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 400,
      tools: [CLASSIFY_TOOL],
      tool_choice: { type: 'tool', name: TOOL_NAME },
      messages: [
        {
          role: 'user',
          content: `You are classifying insurance documents. Analyse the following document text and classify it.\n\nDocument text:\n<document>\n${text}\n</document>`,
        },
      ],
    });

    const toolUseBlock = response.content.find((block) => block.type === 'tool_use');
    if (!toolUseBlock || toolUseBlock.type !== 'tool_use') {
      return { status: 'classification_failed', reason: 'No tool use block in response' };
    }

    rawInput = toolUseBlock.input;
  } catch (err) {
    return {
      status: 'classification_failed',
      reason: err instanceof Error ? err.message : 'Claude API call failed',
    };
  }

  const parsed = classificationSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      status: 'classification_failed',
      reason: `Response schema validation failed: ${parsed.error.message}`,
    };
  }

  return { status: 'success', classification: parsed.data };
}
