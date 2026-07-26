import { deflateSync } from 'node:zlib';

/**
 * 极简 PNG 编码器：只用于生成探针自带的纯色测试图片（§3.2「单张自带的测试图片」）。
 *
 * 不引入任何图像库，也不使用用户文件——图片内容完全由本文件确定性生成，
 * 与文件解析（`files/ooxml.ts`）手写 ZIP 的风格一致：自己写、用真实工具验证过格式，
 * 而不是引入依赖只为了一张几像素的纯色图。
 */

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (crcTable !== null) return crcTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  crcTable = table;
  return table;
}

function crc32(buf: Buffer): number {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc = (table[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crcBuf]);
}

export interface SolidColorPngOptions {
  size?: number;
  rgb?: readonly [number, number, number];
}

/** 生成一张 `size x size` 的纯色 PNG（8 位真彩色、无滤波）。 */
export function generateSolidColorPng(options: SolidColorPngOptions = {}): Buffer {
  const size = options.size ?? 4;
  const [r, g, b] = options.rgb ?? [90, 140, 255];

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 2; // 颜色类型：truecolor RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const rowBytes = 1 + size * 3;
  const raw = Buffer.alloc(rowBytes * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * rowBytes] = 0; // 每行 filter type：0（无滤波）
    for (let x = 0; x < size; x += 1) {
      const offset = y * rowBytes + 1 + x * 3;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
    }
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 生成 data URL 形态，供 `ImageInputDescriptor.url` 使用。 */
export function generateSolidColorPngDataUrl(options: SolidColorPngOptions = {}): string {
  return `data:image/png;base64,${generateSolidColorPng(options).toString('base64')}`;
}
