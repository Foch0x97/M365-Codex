import { inflateRawSync } from 'node:zlib';

/**
 * OOXML（docx/xlsx/pptx）文本提取，手写实现，不引第三方依赖（对应实施计划 §M6）。
 *
 * OOXML 文件本质是一个 ZIP 包，内部若干 XML 部件。这里只实现读取所需的最小子集：
 * 定位中央目录（End of Central Directory → Central Directory File Header），
 * 按需读取指定条目的本地文件头并用 `node:zlib.inflateRawSync` 解压（compression
 * method 8 = deflate；0 = 存储，不需要解压）。不支持 ZIP64（OOXML 文档实际大小
 * 远达不到 ZIP64 门槛，遇到会明确抛错而不是错误地解析）。
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
const MAX_COMMENT_SIZE = 65535;

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export class ZipFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipFormatError';
  }
}

/** 从缓冲区尾部向前搜索 EOCD 记录，返回其起始偏移。 */
function findEndOfCentralDirectory(buffer: Buffer): number {
  const searchStart = Math.max(0, buffer.length - EOCD_MIN_SIZE - MAX_COMMENT_SIZE);
  for (let offset = buffer.length - EOCD_MIN_SIZE; offset >= searchStart; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
      return offset;
    }
  }
  throw new ZipFormatError('未找到 ZIP 中央目录结束记录（EOCD），文件可能已损坏或不是合法的 ZIP/OOXML');
}

/** 解析 ZIP 中央目录，列出全部条目（不读取内容）。 */
export function listZipEntries(buffer: Buffer): ZipEntry[] {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirOffset = buffer.readUInt32LE(eocdOffset + 16);

  if (centralDirOffset === 0xffffffff || totalEntries === 0xffff) {
    throw new ZipFormatError('文件使用了 ZIP64 格式，本实现不支持');
  }

  const entries: ZipEntry[] = [];
  let cursor = centralDirOffset;
  for (let i = 0; i < totalEntries; i += 1) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL_DIR_SIGNATURE) {
      throw new ZipFormatError('中央目录条目签名不合法，文件可能已损坏');
    }
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');

    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** 读取指定条目的解压后内容；文件不存在则返回 null。 */
export function readZipEntry(buffer: Buffer, entries: readonly ZipEntry[], name: string): Buffer | null {
  const entry = entries.find((e) => e.name === name);
  if (entry === undefined) return null;

  if (buffer.readUInt32LE(entry.localHeaderOffset) !== LOCAL_FILE_SIGNATURE) {
    throw new ZipFormatError(`条目 ${name} 的本地文件头签名不合法`);
  }
  const nameLength = buffer.readUInt16LE(entry.localHeaderOffset + 26);
  const extraLength = buffer.readUInt16LE(entry.localHeaderOffset + 28);
  const dataStart = entry.localHeaderOffset + 30 + nameLength + extraLength;
  const compressed = buffer.subarray(dataStart, dataStart + entry.compressedSize);

  if (entry.method === 0) return Buffer.from(compressed);
  if (entry.method === 8) return inflateRawSync(compressed);
  throw new ZipFormatError(`条目 ${name} 使用了不支持的压缩方式 (${entry.method})`);
}

/** XML 数值/命名实体反转义，覆盖 OOXML 文本部件里会出现的常见形式。 */
export function unescapeXmlEntities(text: string): string {
  return text
    .replaceAll(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replaceAll(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

function readEntryText(buffer: Buffer, entries: readonly ZipEntry[], name: string): string | null {
  const raw = readZipEntry(buffer, entries, name);
  return raw === null ? null : raw.toString('utf8');
}

/**
 * docx：word/document.xml 里 `<w:p>` 是段落，`<w:t>` 是文本片段，`<w:tab/>`
 * 是制表符，`<w:br/>` 是换行。段落内片段直接拼接，段落之间用换行分隔。
 */
export function extractDocxText(buffer: Buffer): string {
  const entries = listZipEntries(buffer);
  const xml = readEntryText(buffer, entries, 'word/document.xml');
  if (xml === null) {
    throw new ZipFormatError('未找到 word/document.xml，文件不是合法的 docx');
  }

  const paragraphs = xml.split(/<w:p\b[^>]*>/).slice(1);
  const lines = paragraphs.map((paragraph) => {
    let text = '';
    const tagPattern = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^/]*\/>|<w:br\b[^/]*\/>/g;
    let match: RegExpExecArray | null;
    while ((match = tagPattern.exec(paragraph)) !== null) {
      if (match[1] !== undefined) {
        text += unescapeXmlEntities(match[1]);
      } else if (match[0].startsWith('<w:tab')) {
        text += '\t';
      } else {
        text += '\n';
      }
    }
    return text;
  });
  return lines.join('\n').trim();
}

/** 解析 xl/sharedStrings.xml：每个 `<si>` 是一条共享字符串，内部可能有多个 `<t>` 片段。 */
function parseSharedStrings(xml: string | null): string[] {
  if (xml === null) return [];
  const items = xml.split(/<si>/).slice(1);
  return items.map((item) => {
    const texts = [...item.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unescapeXmlEntities(m[1] ?? ''));
    return texts.join('');
  });
}

/** 解析单个 worksheet XML，按行/列拼出制表符分隔的文本。 */
function parseSheetText(xml: string, sharedStrings: readonly string[]): string {
  const rows = [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)];
  const lines: string[] = [];
  for (const rowMatch of rows) {
    const rowXml = rowMatch[1] ?? '';
    const cells = [...rowXml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g)];
    const values = cells.map((cellMatch) => {
      const attrs = cellMatch[1] ?? cellMatch[3] ?? '';
      const inner = cellMatch[2] ?? '';
      const typeMatch = /\st="([^"]+)"/.exec(attrs);
      const type = typeMatch?.[1];

      if (type === 's') {
        const idxMatch = /<v>([\s\S]*?)<\/v>/.exec(inner);
        const idx = idxMatch === null ? NaN : Number(idxMatch[1]);
        return sharedStrings[idx] ?? '';
      }
      if (type === 'inlineStr') {
        const textMatch = /<t\b[^>]*>([\s\S]*?)<\/t>/.exec(inner);
        return textMatch === null ? '' : unescapeXmlEntities(textMatch[1] ?? '');
      }
      const valueMatch = /<v>([\s\S]*?)<\/v>/.exec(inner);
      return valueMatch === null ? '' : unescapeXmlEntities(valueMatch[1] ?? '');
    });
    lines.push(values.join('\t'));
  }
  return lines.join('\n');
}

/** xlsx：按工作表文件名的数字顺序遍历 xl/worksheets/sheetN.xml，逐表拼接。 */
export function extractXlsxText(buffer: Buffer): string {
  const entries = listZipEntries(buffer);
  const sharedStrings = parseSharedStrings(readEntryText(buffer, entries, 'xl/sharedStrings.xml'));

  const sheetEntries = entries
    .filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name))
    .sort((a, b) => sheetNumber(a.name) - sheetNumber(b.name));

  if (sheetEntries.length === 0) {
    throw new ZipFormatError('未找到任何 xl/worksheets/sheetN.xml，文件不是合法的 xlsx');
  }

  const sheets = sheetEntries.map((entry) => {
    const xml = readEntryText(buffer, entries, entry.name) ?? '';
    return parseSheetText(xml, sharedStrings);
  });
  return sheets.join('\n\n').trim();
}

function sheetNumber(name: string): number {
  const match = /sheet(\d+)\.xml$/.exec(name);
  return match?.[1] !== undefined ? Number(match[1]) : 0;
}

/** pptx：按幻灯片文件名的数字顺序遍历 ppt/slides/slideN.xml，取 `<a:t>` 文本。 */
export function extractPptxText(buffer: Buffer): string {
  const entries = listZipEntries(buffer);
  const slideEntries = entries
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
    .sort((a, b) => slideNumber(a.name) - slideNumber(b.name));

  if (slideEntries.length === 0) {
    throw new ZipFormatError('未找到任何 ppt/slides/slideN.xml，文件不是合法的 pptx');
  }

  const slides = slideEntries.map((entry) => {
    const xml = readEntryText(buffer, entries, entry.name) ?? '';
    const paragraphs = xml.split(/<a:p\b[^>]*>/).slice(1);
    const lines = paragraphs.map((paragraph) =>
      [...paragraph.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)]
        .map((m) => unescapeXmlEntities(m[1] ?? ''))
        .join(''),
    );
    return lines.join('\n').trim();
  });
  return slides.filter((s) => s !== '').join('\n\n');
}

function slideNumber(name: string): number {
  const match = /slide(\d+)\.xml$/.exec(name);
  return match?.[1] !== undefined ? Number(match[1]) : 0;
}
