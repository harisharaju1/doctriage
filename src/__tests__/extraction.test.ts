import { writeFile, unlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractText } from '../services/extraction.js';

// Minimal valid single-page PDF with a text stream
const MINIMAL_PDF_WITH_TEXT = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]
   /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj
4 0 obj
<< /Length 56 >>
stream
BT /F1 12 Tf 100 700 Td (Insurance Claim Form) Tj ET
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
xref
0 6
0000000000 65535 f
0000000009 00000 n
0000000062 00000 n
0000000119 00000 n
0000000274 00000 n
0000000381 00000 n
trailer
<< /Size 6 /Root 1 0 R >>
startxref
459
%%EOF`;

async function writeTmp(filename: string, content: string | Buffer): Promise<string> {
  const dir = join(tmpdir(), 'doctriage-test');
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, filename);
  await writeFile(filePath, content);
  return filePath;
}

describe('extractText', () => {
  it('extracts text and page count from a valid PDF', async () => {
    const path = await writeTmp('valid.pdf', MINIMAL_PDF_WITH_TEXT);
    const result = await extractText(path);
    await unlink(path);

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.text).toContain('Insurance Claim Form');
      expect(result.pageCount).toBe(1);
    }
  });

  it('returns extraction_failed for corrupt bytes, not a throw', async () => {
    const path = await writeTmp('corrupt.pdf', Buffer.from('this is not a pdf'));
    const result = await extractText(path);
    await unlink(path);

    expect(result.status).toBe('extraction_failed');
    if (result.status === 'extraction_failed') {
      expect(result.reason).toBeTruthy();
    }
  });

  it('returns extraction_failed when file does not exist, not a throw', async () => {
    const result = await extractText('/tmp/doctriage-test/nonexistent.pdf');

    expect(result.status).toBe('extraction_failed');
    if (result.status === 'extraction_failed') {
      expect(result.reason).toContain('ENOENT');
    }
  });
});
