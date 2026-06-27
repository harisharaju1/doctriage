import { readFile } from 'node:fs/promises';
import { extractText as pdfExtractText } from 'unpdf';

export type ExtractionResult =
  | { status: 'success'; text: string; pageCount: number }
  | { status: 'extraction_failed'; reason: string };

export async function extractText(filePath: string): Promise<ExtractionResult> {
  let buffer: Buffer;
  try {
    buffer = await readFile(filePath);
  } catch (err) {
    return {
      status: 'extraction_failed',
      reason: err instanceof Error ? err.message : 'File could not be read',
    };
  }

  try {
    const { totalPages, text } = await pdfExtractText(new Uint8Array(buffer));
    const joined = text.join('\n').trim();

    if (!joined) {
      return {
        status: 'extraction_failed',
        reason: 'No extractable text found — PDF may be image-only or blank',
      };
    }

    return { status: 'success', text: joined, pageCount: totalPages };
  } catch (err) {
    return {
      status: 'extraction_failed',
      reason: err instanceof Error ? err.message : 'PDF parsing failed',
    };
  }
}
