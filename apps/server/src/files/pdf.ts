/**
 * PDF 文本提取，使用 `pdfjs-dist` 的 legacy Node 构建（对应实施计划 §M6）。
 *
 * 安装该依赖后 `npm audit --audit-level=high` 仍为 0 高危漏洞，符合护栏要求，
 * 因此这里做真实提取，而不是返回 `unsupported_feature`。逐页取
 * `getTextContent()` 的文本项拼接，不做版面还原（不合并断行、不识别表格），
 * 只保证"文本内容不丢"。
 */

// pdfjs-dist 没有声明 exports map，按其 package.json 的实际产物路径直接导入子路径。
// legacy 构建在没有 DOM/Worker 的 Node 环境下可直接同步解析，不需要额外配置 workerSrc。
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

export class PdfExtractionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PdfExtractionError';
  }
}

export async function extractPdfText(buffer: Buffer): Promise<string> {
  const task = getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
  });

  let doc: Awaited<typeof task.promise>;
  try {
    doc = await task.promise;
  } catch (error) {
    throw new PdfExtractionError('无法解析 PDF：文件可能已损坏或不是合法的 PDF', { cause: error });
  }

  try {
    const pageTexts: string[] = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const items = content.items as { str?: string }[];
      const text = items.map((item) => item.str ?? '').join('');
      pageTexts.push(text);
    }
    return pageTexts.join('\n\n').trim();
  } catch (error) {
    throw new PdfExtractionError('PDF 文本提取失败', { cause: error });
  } finally {
    await task.destroy();
  }
}
