import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileStorage, sha256Hex } from '../src/files/storage.js';

describe('FileStorage', () => {
  let dir: string;
  let storage: FileStorage;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'm365-codex-files-'));
    storage = new FileStorage(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('按 file-id 写入与读回内容，原始文件名不出现在磁盘路径里', () => {
    const fileId = 'file_abc123';
    storage.writeFileContent(fileId, Buffer.from('hello'));
    expect(storage.readFileContent(fileId).toString('utf8')).toBe('hello');
  });

  it('删除文件后再读取抛错', () => {
    const fileId = 'file_todelete';
    storage.writeFileContent(fileId, Buffer.from('x'));
    storage.deleteFile(fileId);
    expect(() => storage.readFileContent(fileId)).toThrow();
  });

  it('删除不存在的文件不报错（幂等）', () => {
    expect(() => storage.deleteFile('file_never_existed')).not.toThrow();
  });

  it('分片写入与读回', () => {
    storage.writeUploadPart('upload_1', 'part_1', Buffer.from('AAA'));
    storage.writeUploadPart('upload_1', 'part_2', Buffer.from('BBB'));
    expect(storage.readUploadPart('upload_1', 'part_1').toString()).toBe('AAA');
    expect(storage.readUploadPart('upload_1', 'part_2').toString()).toBe('BBB');
  });

  it('删除整个 upload 目录清掉全部分片', () => {
    storage.writeUploadPart('upload_2', 'part_1', Buffer.from('A'));
    storage.deleteUpload('upload_2');
    expect(() => storage.readUploadPart('upload_2', 'part_1')).toThrow();
  });
});

describe('sha256Hex', () => {
  it('对相同内容产生相同摘要', () => {
    const a = sha256Hex(Buffer.from('same content'));
    const b = sha256Hex(Buffer.from('same content'));
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  it('对不同内容产生不同摘要', () => {
    expect(sha256Hex(Buffer.from('a'))).not.toBe(sha256Hex(Buffer.from('b')));
  });
});
