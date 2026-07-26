import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractPdfText, PdfExtractionError } from '../src/files/pdf.js';

function fixture(name: string): Buffer {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));
}

describe('extractPdfText', () => {
  it('提取单页 PDF 的文本', async () => {
    const text = await extractPdfText(fixture('sample.pdf'));
    expect(text).toContain('Hello PDF');
  });

  it('损坏的 PDF 抛出 PdfExtractionError', async () => {
    await expect(extractPdfText(Buffer.from('not a pdf at all'))).rejects.toThrow(PdfExtractionError);
  });
});
