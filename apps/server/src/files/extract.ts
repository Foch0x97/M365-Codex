import { extractDocxText, extractPptxText, extractXlsxText, ZipFormatError } from './ooxml.js';
import { extractPdfText, PdfExtractionError } from './pdf.js';
import type { ExtractionResult, FileKind } from './types.js';

/**
 * 文本提取总调度（对应实施计划 §11、§M6）。
 *
 * 提取本身绝不吞错误：能提取的给出文本，明确跳过的给出原因，失败的给出失败
 * 原因——三种情况在 `ExtractionResult` 里都清楚区分，不允许"看似成功但内容是
 * 空字符串"这种含糊状态。
 */
export async function extractText(
  buffer: Buffer,
  kind: FileKind,
  trusted: boolean,
): Promise<ExtractionResult> {
  if (!trusted) {
    return skip('扩展名、MIME 与文件内容魔数三者不一致，按不可信处理，仅存储不提取');
  }

  switch (kind) {
    case 'text':
      return extractPlainText(buffer);
    case 'pdf':
      return extractPdf(buffer);
    case 'docx':
      return extractZipXml(() => extractDocxText(buffer));
    case 'xlsx':
      return extractZipXml(() => extractXlsxText(buffer));
    case 'pptx':
      return extractZipXml(() => extractPptxText(buffer));
    case 'image':
      // 图片走 Responses 的 input_image 通道，不是文本提取的对象
      return skip('图片文件用于图片输入，不做文本提取');
    case 'unknown':
      return skip('未识别的二进制文件，不猜测内容，仅存储');
  }
}

function skip(note: string): ExtractionResult {
  return { ok: false, text: null, note, skipped: true };
}

function extractPlainText(buffer: Buffer): ExtractionResult {
  try {
    // classify 阶段已用 fatal 解码验证过合法性，这里再解码一次是为了拿到真正的
    // 字符串内容；理论上不会在这里失败，失败即视为内容不可提取而非抛异常中断。
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return { ok: true, text, note: null, skipped: false };
  } catch (error) {
    return {
      ok: false,
      text: null,
      note: `不是合法的 UTF-8 文本：${(error as Error).message}`,
      skipped: false,
    };
  }
}

async function extractPdf(buffer: Buffer): Promise<ExtractionResult> {
  try {
    const text = await extractPdfText(buffer);
    return { ok: true, text, note: null, skipped: false };
  } catch (error) {
    const message = error instanceof PdfExtractionError ? error.message : 'PDF 文本提取失败';
    return { ok: false, text: null, note: message, skipped: false };
  }
}

function extractZipXml(run: () => string): ExtractionResult {
  try {
    return { ok: true, text: run(), note: null, skipped: false };
  } catch (error) {
    const message = error instanceof ZipFormatError ? error.message : 'Office 文档文本提取失败';
    return { ok: false, text: null, note: message, skipped: false };
  }
}
