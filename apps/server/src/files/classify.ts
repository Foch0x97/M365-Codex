import type { FileKind } from './types.js';

/**
 * 扩展名 + MIME + 文件魔数三者联合检查（对应实施计划 §11：「联合检查扩展名、
 * MIME 与文件魔数」「未识别二进制不猜测内容」）。
 *
 * 设计：三个信号各自独立判断出一个 kind（拿不准就是 'unknown'，即"无意见"，
 * 不强行归类）。把有意见的信号收集起来：
 * - 没有任何信号有意见 → 无法识别，kind='unknown'，trusted=false；
 * - 意见一致（唯一值）→ trusted=true，按该 kind 处理；
 * - 意见冲突 → 不可信，kind='unknown'，trusted=false（不猜测，只存储不提取）。
 *
 * OOXML（docx/xlsx/pptx）在字节层面共享同一个 ZIP 签名，魔数信号只能给出
 * 泛化的 'ooxml-zip'，具体是哪种交给扩展名/MIME 决定；两者都没意见时不猜，
 * 一律按 unknown 处理——避免把任意 .zip 当成 Office 文档硬解析。
 */

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.log',
  '.yml', '.yaml', '.xml', '.ini', '.conf', '.toml',
  '.py', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.java', '.c', '.h',
  '.cpp', '.hpp', '.cs', '.go', '.rs', '.rb', '.php', '.sh', '.bash', '.ps1',
  '.sql', '.html', '.htm', '.css', '.svg',
]);

const EXTENSION_KIND: ReadonlyMap<string, FileKind> = new Map<string, FileKind>([
  ...[...TEXT_EXTENSIONS].map((ext): [string, FileKind] => [ext, 'text']),
  ['.pdf', 'pdf'],
  ['.docx', 'docx'],
  ['.xlsx', 'xlsx'],
  ['.pptx', 'pptx'],
  ['.png', 'image'],
  ['.jpg', 'image'],
  ['.jpeg', 'image'],
  ['.gif', 'image'],
  ['.webp', 'image'],
]);

const TEXT_MIME_PREFIXES = ['text/'];
const TEXT_MIME_EXACT = new Set([
  'application/json',
  'application/x-ndjson',
  'application/yaml',
  'application/x-yaml',
  'application/xml',
  'application/javascript',
  'application/x-sh',
  'application/toml',
  'application/sql',
]);

const MIME_KIND_EXACT: ReadonlyMap<string, FileKind> = new Map([
  ['application/pdf', 'pdf'],
  [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'docx',
  ],
  [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'xlsx',
  ],
  [
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'pptx',
  ],
  ['image/png', 'image'],
  ['image/jpeg', 'image'],
  ['image/gif', 'image'],
  ['image/webp', 'image'],
]);

/** 通用/无信息量的 MIME：客户端经常兜底发这些，不当作"有意见"的信号。 */
const GENERIC_MIME = new Set(['application/octet-stream', 'application/zip', '']);

export function extKindOf(filename: string): FileKind | 'unknown' {
  const idx = filename.lastIndexOf('.');
  if (idx < 0) return 'unknown';
  const ext = filename.slice(idx).toLowerCase();
  return EXTENSION_KIND.get(ext) ?? 'unknown';
}

export function mimeKindOf(mime: string | null): FileKind | 'unknown' {
  if (mime === null) return 'unknown';
  const normalized = mime.split(';')[0]?.trim().toLowerCase() ?? '';
  if (GENERIC_MIME.has(normalized)) return 'unknown';
  const exact = MIME_KIND_EXACT.get(normalized);
  if (exact !== undefined) return exact;
  if (TEXT_MIME_EXACT.has(normalized)) return 'text';
  if (TEXT_MIME_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return 'text';
  return 'unknown';
}

type MagicKind = FileKind | 'ooxml-zip';

/** 已知二进制签名的字节级嗅探；文本没有魔数，靠"整段可解码为合法 UTF-8"兜底判断。 */
export function magicKindOf(buffer: Buffer): MagicKind {
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image'; // PNG
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return 'image'; // JPEG
  if (startsWith(buffer, [0x47, 0x49, 0x46, 0x38])) return 'image'; // GIF8
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buffer.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image';
  }
  if (buffer.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (startsWith(buffer, [0x50, 0x4b, 0x03, 0x04])) return 'ooxml-zip'; // ZIP local file header

  return isLikelyUtf8Text(buffer) ? 'text' : 'unknown';
}

function startsWith(buffer: Buffer, signature: readonly number[]): boolean {
  if (buffer.length < signature.length) return false;
  for (let i = 0; i < signature.length; i += 1) {
    if (buffer[i] !== signature[i]) return false;
  }
  return true;
}

/**
 * 合法 UTF-8 且不含 NUL 字节视为文本。`TextDecoder({fatal:true})` 对绝大多数
 * 二进制格式（有固定字节头）会直接抛错，足够区分；宁可保守（判成 unknown）
 * 也不去猜。
 */
function isLikelyUtf8Text(buffer: Buffer): boolean {
  if (buffer.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

export interface ClassifyResult {
  kind: FileKind;
  trusted: boolean;
}

export function classifyFile(filename: string, declaredMime: string | null, buffer: Buffer): ClassifyResult {
  const extKind = extKindOf(filename);
  const mimeKind = mimeKindOf(declaredMime);
  const magicKind = magicKindOf(buffer);

  // 结构性信号（扩展名 / MIME）先各自定意见；ooxml-zip 在这一步先当"无意见"处理，
  // 稍后按结构信号是否一致来决定能不能采信它。
  const structural = new Set<FileKind>();
  if (extKind !== 'unknown') structural.add(extKind);
  if (mimeKind !== 'unknown') structural.add(mimeKind);

  if (structural.size > 1) {
    // 扩展名与 MIME 自己就对不上，不必再看魔数
    return { kind: 'unknown', trusted: false };
  }

  const agreedStructuralKind = structural.size === 1 ? [...structural][0] : undefined;

  if (magicKind === 'ooxml-zip') {
    if (agreedStructuralKind !== undefined && isOoxmlKind(agreedStructuralKind)) {
      return { kind: agreedStructuralKind, trusted: true };
    }
    // 光凭 ZIP 签名认不出具体是哪种 Office 文档，不猜
    return { kind: 'unknown', trusted: false };
  }

  // 没有任何结构性信号（扩展名不认识、MIME 是通用值）：只能靠魔数独自定论。
  if (agreedStructuralKind === undefined) {
    return magicKind === 'unknown' ? { kind: 'unknown', trusted: false } : { kind: magicKind, trusted: true };
  }

  // 有结构性信号：字节内容必须实际印证它，魔数给不出同样的结论（包括
  // magicKind==='unknown'，即字节既不是合法文本也不匹配任何已知签名）都算不一致。
  if (magicKind === agreedStructuralKind) {
    return { kind: agreedStructuralKind, trusted: true };
  }
  return { kind: 'unknown', trusted: false };
}

function isOoxmlKind(kind: FileKind): boolean {
  return kind === 'docx' || kind === 'xlsx' || kind === 'pptx';
}
