import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { packArchive, unpackArchive } from '../src/backup/archive.js';

/**
 * 备份包格式：能自洽往返，且**能被系统 tar 打开**——备份的价值在于
 * 没有本项目时也读得出来。
 */

const NOW = 1_700_000_000_000;

describe('打包与解包', () => {
  it('往返后内容一致', () => {
    const entries = [
      { path: 'manifest.json', content: Buffer.from('{"version":1}', 'utf8') },
      { path: 'db.sqlite', content: Buffer.from([0, 1, 2, 3, 255, 254]) },
      { path: 'files/9f1c/0001', content: Buffer.from('附件内容，含中文', 'utf8') },
    ];
    const restored = unpackArchive(packArchive(entries, NOW));
    expect(restored.map((e) => e.path)).toEqual(entries.map((e) => e.path));
    for (let i = 0; i < entries.length; i += 1) {
      expect(restored[i]?.content.equals(entries[i]?.content as Buffer)).toBe(true);
    }
  });

  it('空文件与恰好 512 字节的文件都能正确还原', () => {
    const entries = [
      { path: 'empty', content: Buffer.alloc(0) },
      { path: 'exact-block', content: Buffer.alloc(512, 7) },
      { path: 'after', content: Buffer.from('尾部标记', 'utf8') },
    ];
    const restored = unpackArchive(packArchive(entries, NOW));
    expect(restored[0]?.content.byteLength).toBe(0);
    expect(restored[1]?.content.byteLength).toBe(512);
    expect(restored[2]?.content.toString('utf8')).toBe('尾部标记');
  });

  it('长路径走 ustar 的 prefix 拆分', () => {
    const deep = `files/${'a'.repeat(80)}/${'b'.repeat(60)}`;
    const restored = unpackArchive(packArchive([{ path: deep, content: Buffer.from('x') }], NOW));
    expect(restored[0]?.path).toBe(deep);
  });
});

describe('路径安全', () => {
  it('拒绝绝对路径与 .. 逃逸', () => {
    expect(() => packArchive([{ path: '/etc/passwd', content: Buffer.alloc(1) }], NOW)).toThrow(/不合法/);
    expect(() => packArchive([{ path: '../outside', content: Buffer.alloc(1) }], NOW)).toThrow(/不合法/);
  });

  it('解包时同样拒绝逃逸路径', () => {
    // 手工造一个带 ../ 的合法 tar：先打包正常路径，再篡改头部里的文件名
    const packed = packArchive([{ path: 'safe/name', content: Buffer.from('x') }], NOW);
    const raw = gunzipSync(packed);
    raw.fill(0, 0, 100);
    raw.write('../evil', 0, 100, 'utf8');
    // 重算校验和
    raw.write('        ', 148, 8, 'ascii');
    let checksum = 0;
    for (const byte of raw.subarray(0, 512)) checksum += byte;
    raw.write(`${checksum.toString(8).padStart(7, '0')}\0`, 148, 8, 'ascii');
    const tampered = gzipSync(raw);
    expect(() => unpackArchive(tampered)).toThrow(/不合法/);
  });
});

describe('与系统 tar 的互操作', () => {
  it('生成的包能被系统 tar 列出并解出', () => {
    const dir = mkdtempSync(join(tmpdir(), 'm365-tar-'));
    try {
      const archive = packArchive(
        [
          { path: 'manifest.json', content: Buffer.from('{"version":1}', 'utf8') },
          { path: 'files/a/1', content: Buffer.from('hello', 'utf8') },
        ],
        NOW,
      );
      const archivePath = join(dir, 'backup.tar.gz');
      writeFileSync(archivePath, archive);

      // 只在「环境里根本没有 tar」时跳过。tar 存在却解不开必须报错——
      // 之前这里 catch 得太宽，把「系统 tar 说格式无法识别」也当成了跳过，
      // 结果一个真实的格式 bug 在绿色的测试结果下藏了过去。
      let hasTar = true;
      try {
        execFileSync('tar', ['--version'], { stdio: 'ignore' });
      } catch {
        hasTar = false;
      }
      if (!hasTar) return;

      const listing = execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf8' });
      expect(listing).toContain('manifest.json');
      expect(listing).toContain('files/a/1');

      execFileSync('tar', ['-xzf', archivePath, '-C', dir]);
      const extracted = readFileSync(join(dir, 'files', 'a', '1'), 'utf8');
      expect(extracted).toBe('hello');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
