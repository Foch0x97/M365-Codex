import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractText } from '../src/files/extract.js';

function fixture(name: string): Buffer {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));
}

describe('extractText', () => {
  it('不可信文件不提取，给出明确原因，且是策略性跳过而非失败', async () => {
    const result = await extractText(Buffer.from('hello'), 'text', false);
    expect(result.ok).toBe(false);
    expect(result.text).toBeNull();
    expect(result.note).toContain('不可信');
    expect(result.skipped).toBe(true);
  });

  it('纯文本直接解码', async () => {
    const result = await extractText(Buffer.from('纯文本内容', 'utf8'), 'text', true);
    expect(result).toEqual({ ok: true, text: '纯文本内容', note: null, skipped: false });
  });

  it('图片不提取文本但不算失败', async () => {
    const result = await extractText(Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'image', true);
    expect(result.ok).toBe(false);
    expect(result.note).toContain('图片');
    expect(result.skipped).toBe(true);
  });

  it('未识别二进制不猜测内容', async () => {
    const result = await extractText(Buffer.from([1, 2, 3]), 'unknown', true);
    expect(result.ok).toBe(false);
    expect(result.note).toContain('不猜测');
    expect(result.skipped).toBe(true);
  });

  it('PDF 提取文本', async () => {
    const result = await extractText(fixture('sample.pdf'), 'pdf', true);
    expect(result.ok).toBe(true);
    expect(result.text).toContain('Hello PDF');
  });

  it('docx 提取文本', async () => {
    const result = await extractText(fixture('sample.docx'), 'docx', true);
    expect(result.ok).toBe(true);
    expect(result.text).toContain('Hello OOXML');
  });

  it('xlsx 提取文本', async () => {
    const result = await extractText(fixture('sample.xlsx'), 'xlsx', true);
    expect(result.ok).toBe(true);
    expect(result.text).toContain('Alice');
  });

  it('pptx 提取文本', async () => {
    const result = await extractText(fixture('sample.pptx'), 'pptx', true);
    expect(result.ok).toBe(true);
    expect(result.text).toContain('Slide One Title');
  });

  it('损坏的 docx 提取失败但明确报告原因，且算真失败而非跳过', async () => {
    const result = await extractText(fixture('plain.zip'), 'docx', true);
    expect(result.ok).toBe(false);
    expect(result.note).toBeTruthy();
    expect(result.skipped).toBe(false);
  });
});
