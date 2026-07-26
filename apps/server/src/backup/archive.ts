import { Buffer } from 'node:buffer';
import { gunzipSync, gzipSync } from 'node:zlib';

/**
 * 极小的 tar（ustar）打包/解包（对应实施计划 §15.4 备份与恢复）。
 *
 * 为什么不引第三方包：备份包只需要「若干个文件打成一个流、能用系统 tar 打开」这一件事。
 * 用标准 tar.gz 而不是自造格式，是为了让管理员在没有本项目的情况下也能用
 * `tar -tzf` 查看、`tar -xzf` 取出内容——备份的价值在于任何时候都能读得出来。
 *
 * 只支持普通文件（typeflag '0'），文件名走 ustar 的 prefix/name 拆分，
 * 足够覆盖 `files/<uuid>/<序号>` 这种深度。
 */

const BLOCK = 512;

export interface ArchiveEntry {
  /** 归档内路径，使用 / 分隔，不允许以 / 开头或包含 .. */
  path: string;
  content: Buffer;
  /** Unix 权限位，默认 0o644 */
  mode?: number;
  /** 修改时间（毫秒），默认取打包时刻由调用方传入 */
  mtimeMs?: number;
}

function assertSafePath(path: string): void {
  if (path === '' || path.startsWith('/') || path.split('/').includes('..')) {
    throw new Error(`归档路径不合法：${path}`);
  }
}

/** ustar 头部里的数字字段是补零的八进制字符串，末尾留一个 NUL。 */
function writeOctal(buffer: Buffer, value: number, offset: number, length: number): void {
  const text = value.toString(8).padStart(length - 1, '0');
  buffer.write(`${text}\0`, offset, length, 'ascii');
}

function buildHeader(entry: ArchiveEntry, mtimeMs: number): Buffer {
  const header = Buffer.alloc(BLOCK);

  // 长路径拆成 prefix(155) + name(100)
  let name = entry.path;
  let prefix = '';
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf('/', 155);
    if (cut <= 0 || Buffer.byteLength(name.slice(cut + 1)) > 100) {
      throw new Error(`归档路径过长：${entry.path}`);
    }
    prefix = name.slice(0, cut);
    name = name.slice(cut + 1);
  }

  header.write(name, 0, 100, 'utf8');
  writeOctal(header, entry.mode ?? 0o644, 100, 8);
  writeOctal(header, 0, 108, 8); // uid
  writeOctal(header, 0, 116, 8); // gid
  writeOctal(header, entry.content.byteLength, 124, 12);
  writeOctal(header, Math.floor(mtimeMs / 1000), 136, 12);
  header.write('        ', 148, 8, 'ascii'); // 校验和先填空格
  header.write('0', 156, 1, 'ascii'); // typeflag：普通文件
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  if (prefix !== '') header.write(prefix, 345, 155, 'utf8');

  // 校验和字段的排布是 ustar 里唯一的例外：6 位八进制 + NUL + 空格，
  // 不是别的字段那种「补零八进制 + NUL」。按常规写法写出来的包，
  // 系统 tar 会直接判为「无法识别的归档格式」。
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');

  return header;
}

function padding(size: number): Buffer {
  const remainder = size % BLOCK;
  return remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - remainder);
}

/** 打包成 tar.gz。 */
export function packArchive(entries: readonly ArchiveEntry[], now: number): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    assertSafePath(entry.path);
    chunks.push(buildHeader(entry, entry.mtimeMs ?? now), entry.content, padding(entry.content.byteLength));
  }
  // tar 以两个全零块结尾
  chunks.push(Buffer.alloc(BLOCK * 2));
  return gzipSync(Buffer.concat(chunks));
}

/** 解包 tar.gz。遇到不认识的条目类型会跳过，路径不安全则抛错。 */
export function unpackArchive(archive: Buffer): ArchiveEntry[] {
  const buffer = gunzipSync(archive);
  const entries: ArchiveEntry[] = [];

  let offset = 0;
  while (offset + BLOCK <= buffer.byteLength) {
    const header = buffer.subarray(offset, offset + BLOCK);
    // 全零块表示结束
    if (header.every((byte) => byte === 0)) break;

    const readString = (start: number, length: number): string =>
      header.subarray(start, start + length).toString('utf8').replace(/\0.*$/, '');
    const readOctal = (start: number, length: number): number => {
      const text = readString(start, length).trim();
      return text === '' ? 0 : Number.parseInt(text, 8);
    };

    const name = readString(0, 100);
    const prefix = readString(345, 155);
    const size = readOctal(124, 12);
    const typeflag = readString(156, 1);
    const mode = readOctal(100, 8);
    const mtimeMs = readOctal(136, 12) * 1000;

    offset += BLOCK;
    const content = buffer.subarray(offset, offset + size);
    offset += size + padding(size).byteLength;

    // '' 与 '0' 都表示普通文件；其余（目录、软链等）跳过
    if (typeflag !== '' && typeflag !== '0') continue;

    const path = prefix === '' ? name : `${prefix}/${name}`;
    assertSafePath(path);
    entries.push({ path, content: Buffer.from(content), mode, mtimeMs });
  }

  return entries;
}
