import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, runMigrations, type Database } from '../src/db/index.js';
import { cleanupExpiredFiles, cleanupExpiredUploads, runFilesCleanup } from '../src/files/cleanup.js';
import { FileStorage } from '../src/files/storage.js';
import { ApiKeyRepository } from '../src/repo/apiKeys.js';
import { FileRepository, UploadRepository } from '../src/repo/files.js';

describe('files/cleanup', () => {
  let db: Database;
  let dir: string;
  let files: FileRepository;
  let uploads: UploadRepository;
  let storage: FileStorage;
  let apiKeyId: string;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db);
    dir = mkdtempSync(join(tmpdir(), 'm365-codex-cleanup-'));
    files = new FileRepository(db);
    uploads = new UploadRepository(db);
    storage = new FileStorage(dir);
    apiKeyId = new ApiKeyRepository(db).create({ name: 'k' }).id;
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('清理已过期的文件：软删除 + 删掉磁盘内容', () => {
    const now = Date.now();
    files.create({
      id: 'file_exp', apiKeyId, filename: 'a.txt', purpose: 'user_data', mimeType: 'text/plain',
      kind: 'text', bytes: 5, sha256: 'a'.repeat(64), status: 'processed', extractedText: 'hi',
      extractionNote: null, expiresAt: now - 1000,
    });
    storage.writeFileContent('file_exp', Buffer.from('hi'));

    const count = cleanupExpiredFiles({ files, uploads, storage }, now);

    expect(count).toBe(1);
    expect(files.findOwnedActive('file_exp', apiKeyId)).toBeUndefined();
    expect(() => storage.readFileContent('file_exp')).toThrow();
  });

  it('未过期的文件不受影响', () => {
    const now = Date.now();
    files.create({
      id: 'file_ok', apiKeyId, filename: 'a.txt', purpose: 'user_data', mimeType: 'text/plain',
      kind: 'text', bytes: 5, sha256: 'b'.repeat(64), status: 'processed', extractedText: 'hi',
      extractionNote: null, expiresAt: now + 100_000,
    });
    const count = cleanupExpiredFiles({ files, uploads, storage }, now);
    expect(count).toBe(0);
    expect(files.findOwnedActive('file_ok', apiKeyId)).toBeDefined();
  });

  it('清理已过期仍 pending 的 Upload：标记 expired + 删掉已收分片', () => {
    const now = Date.now();
    uploads.create({
      id: 'upload_exp', apiKeyId, filename: 'big.bin', purpose: 'user_data',
      mimeType: 'application/octet-stream', bytes: 100, expiresAt: now - 1000,
    });
    storage.writeUploadPart('upload_exp', 'part_1', Buffer.from('chunk'));

    const count = cleanupExpiredUploads({ files, uploads, storage }, now);

    expect(count).toBe(1);
    expect(uploads.findById('upload_exp')?.status).toBe('expired');
    expect(() => storage.readUploadPart('upload_exp', 'part_1')).toThrow();
  });

  it('已完成或已取消的 Upload 不受清理影响', () => {
    const now = Date.now();
    uploads.create({
      id: 'upload_done', apiKeyId, filename: 'x', purpose: 'user_data',
      mimeType: 'text/plain', bytes: 1, expiresAt: now - 1000,
    });
    uploads.markCancelled('upload_done');
    const count = cleanupExpiredUploads({ files, uploads, storage }, now);
    expect(count).toBe(0);
    expect(uploads.findById('upload_done')?.status).toBe('cancelled');
  });

  it('runFilesCleanup 汇总两类清理数量', () => {
    const now = Date.now();
    files.create({
      id: 'file_a', apiKeyId, filename: 'a.txt', purpose: 'user_data', mimeType: 'text/plain',
      kind: 'text', bytes: 1, sha256: 'c'.repeat(64), status: 'processed', extractedText: null,
      extractionNote: null, expiresAt: now - 1,
    });
    uploads.create({
      id: 'upload_a', apiKeyId, filename: 'x', purpose: 'user_data',
      mimeType: 'text/plain', bytes: 1, expiresAt: now - 1,
    });
    const result = runFilesCleanup({ files, uploads, storage }, now);
    expect(result).toEqual({ expiredFiles: 1, expiredUploads: 1 });
  });
});
