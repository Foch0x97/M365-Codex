import { randomUUID } from 'node:crypto';
import { asRow, asRows, type Database } from '../db/index.js';
import type { FileKind, FileStatus, UploadStatus } from '../files/types.js';

/**
 * 文件 / 分片上传的数据访问层（对应实施计划 §11、§M6）。
 *
 * 归属规则：所有查询都要求调用方带上 `apiKeyId` 做过滤——一个 API Key 只能看到、
 * 读到、删到自己创建的文件，列表也不例外（不只是内容读不到，连存在与否都不可见）。
 */

export interface FileRow {
  id: string;
  api_key_id: string;
  filename: string;
  purpose: string;
  mime_type: string;
  kind: FileKind;
  bytes: number;
  sha256: string;
  status: FileStatus;
  extracted_text: string | null;
  extraction_note: string | null;
  created_at: number;
  expires_at: number | null;
  deleted_at: number | null;
}

export interface CreateFileInput {
  id: string;
  apiKeyId: string;
  filename: string;
  purpose: string;
  mimeType: string;
  kind: FileKind;
  bytes: number;
  sha256: string;
  status: FileStatus;
  extractedText: string | null;
  extractionNote: string | null;
  expiresAt: number | null;
}

export class FileRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  create(input: CreateFileInput, now = Date.now()): FileRow {
    this.#db
      .prepare(
        `INSERT INTO files (
           id, api_key_id, filename, purpose, mime_type, kind, bytes, sha256,
           status, extracted_text, extraction_note, created_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.apiKeyId,
        input.filename,
        input.purpose,
        input.mimeType,
        input.kind,
        input.bytes,
        input.sha256,
        input.status,
        input.extractedText,
        input.extractionNote,
        now,
        input.expiresAt,
      );
    const row = this.findById(input.id);
    if (row === undefined) throw new Error('文件创建后立即读取失败');
    return row;
  }

  findById(id: string): FileRow | undefined {
    return asRow<FileRow>(this.#db.prepare('SELECT * FROM files WHERE id = ?').get(id));
  }

  /** 找一份「未被删除」的文件，且必须属于指定 Key；否则视为不存在（不泄露存在性）。 */
  findOwnedActive(id: string, apiKeyId: string): FileRow | undefined {
    return asRow<FileRow>(
      this.#db
        .prepare('SELECT * FROM files WHERE id = ? AND api_key_id = ? AND deleted_at IS NULL')
        .get(id, apiKeyId),
    );
  }

  listByApiKey(apiKeyId: string, purpose?: string | null): FileRow[] {
    if (purpose !== undefined && purpose !== null) {
      return asRows<FileRow>(
        this.#db
          .prepare(
            'SELECT * FROM files WHERE api_key_id = ? AND purpose = ? AND deleted_at IS NULL ORDER BY created_at DESC',
          )
          .all(apiKeyId, purpose),
      );
    }
    return asRows<FileRow>(
      this.#db
        .prepare('SELECT * FROM files WHERE api_key_id = ? AND deleted_at IS NULL ORDER BY created_at DESC')
        .all(apiKeyId),
    );
  }

  /** 该 Key 当前占用的存储字节数（未删除、未过期）。 */
  sumActiveBytes(apiKeyId: string, now = Date.now()): number {
    const row = asRow<{ total: number | null }>(
      this.#db
        .prepare(
          `SELECT SUM(bytes) AS total FROM files
           WHERE api_key_id = ? AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
        )
        .get(apiKeyId, now),
    );
    return row?.total ?? 0;
  }

  /** 软删除：保留行以便审计，但内容与元数据都不再对外可见。 */
  softDelete(id: string, apiKeyId: string, now = Date.now()): boolean {
    const result = this.#db
      .prepare('UPDATE files SET deleted_at = ? WHERE id = ? AND api_key_id = ? AND deleted_at IS NULL')
      .run(now, id, apiKeyId);
    return Number(result.changes) > 0;
  }

  /** 找出已过期但尚未清理的文件（供清理任务使用，不区分 API Key）。 */
  findExpired(now = Date.now()): FileRow[] {
    return asRows<FileRow>(
      this.#db
        .prepare('SELECT * FROM files WHERE deleted_at IS NULL AND expires_at IS NOT NULL AND expires_at < ?')
        .all(now),
    );
  }

  /** 管理视角的文件列表（契约 §2.6），可选按 API Key 过滤，跨 Key 可见。 */
  listForAdmin(filters: { limit: number; apiKeyId?: string }): { items: FileRow[]; totalBytes: number } {
    if (filters.apiKeyId !== undefined) {
      const items = asRows<FileRow>(
        this.#db
          .prepare(
            'SELECT * FROM files WHERE api_key_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ?',
          )
          .all(filters.apiKeyId, filters.limit),
      );
      const totalBytes = this.sumActiveBytes(filters.apiKeyId);
      return { items, totalBytes };
    }
    const items = asRows<FileRow>(
      this.#db.prepare('SELECT * FROM files WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT ?').all(
        filters.limit,
      ),
    );
    const totalRow = asRow<{ total: number | null }>(
      this.#db.prepare('SELECT SUM(bytes) AS total FROM files WHERE deleted_at IS NULL').get(),
    );
    return { items, totalBytes: totalRow?.total ?? 0 };
  }

  /** 管理端删除：跳过归属校验（契约 §2.6 `DELETE /admin/files/:id`）。 */
  adminSoftDelete(id: string, now = Date.now()): FileRow | undefined {
    const existing = this.findById(id);
    if (existing === undefined || existing.deleted_at !== null) return undefined;
    this.#db.prepare('UPDATE files SET deleted_at = ? WHERE id = ?').run(now, id);
    return this.findById(id);
  }
}

export interface UploadRow {
  id: string;
  api_key_id: string;
  filename: string;
  purpose: string;
  mime_type: string;
  bytes: number;
  status: UploadStatus;
  file_id: string | null;
  created_at: number;
  expires_at: number;
}

export interface CreateUploadInput {
  id: string;
  apiKeyId: string;
  filename: string;
  purpose: string;
  mimeType: string;
  bytes: number;
  expiresAt: number;
}

export interface UploadPartRow {
  id: string;
  upload_id: string;
  part_number: number;
  bytes: number;
  created_at: number;
}

export class UploadRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  create(input: CreateUploadInput, now = Date.now()): UploadRow {
    this.#db
      .prepare(
        `INSERT INTO uploads (id, api_key_id, filename, purpose, mime_type, bytes, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(input.id, input.apiKeyId, input.filename, input.purpose, input.mimeType, input.bytes, now, input.expiresAt);
    const row = this.findById(input.id);
    if (row === undefined) throw new Error('Upload 创建后立即读取失败');
    return row;
  }

  findById(id: string): UploadRow | undefined {
    return asRow<UploadRow>(this.#db.prepare('SELECT * FROM uploads WHERE id = ?').get(id));
  }

  findOwned(id: string, apiKeyId: string): UploadRow | undefined {
    return asRow<UploadRow>(
      this.#db.prepare('SELECT * FROM uploads WHERE id = ? AND api_key_id = ?').get(id, apiKeyId),
    );
  }

  /** 追加一个分片记录；分片号重复会因 UNIQUE 约束抛错，交由调用方决定如何处理。 */
  addPart(uploadId: string, bytes: number, now = Date.now()): UploadPartRow {
    const id = `part_${randomUUID().replaceAll('-', '')}`;
    const partNumber = this.#nextPartNumber(uploadId);
    this.#db
      .prepare(
        'INSERT INTO upload_parts (id, upload_id, part_number, bytes, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, uploadId, partNumber, bytes, now);
    const row = asRow<UploadPartRow>(
      this.#db.prepare('SELECT * FROM upload_parts WHERE id = ?').get(id),
    );
    if (row === undefined) throw new Error('分片创建后立即读取失败');
    return row;
  }

  #nextPartNumber(uploadId: string): number {
    const row = asRow<{ next: number }>(
      this.#db
        .prepare('SELECT COALESCE(MAX(part_number), 0) + 1 AS next FROM upload_parts WHERE upload_id = ?')
        .get(uploadId),
    );
    return row?.next ?? 1;
  }

  findPartById(id: string): UploadPartRow | undefined {
    return asRow<UploadPartRow>(this.#db.prepare('SELECT * FROM upload_parts WHERE id = ?').get(id));
  }

  listParts(uploadId: string): UploadPartRow[] {
    return asRows<UploadPartRow>(
      this.#db
        .prepare('SELECT * FROM upload_parts WHERE upload_id = ? ORDER BY part_number ASC')
        .all(uploadId),
    );
  }

  markCompleted(id: string, fileId: string): void {
    this.#db
      .prepare(
        "UPDATE uploads SET status = 'completed', file_id = ? WHERE id = ? AND status = 'pending'",
      )
      .run(fileId, id);
  }

  markCancelled(id: string): boolean {
    const result = this.#db
      .prepare("UPDATE uploads SET status = 'cancelled' WHERE id = ? AND status = 'pending'")
      .run(id);
    return Number(result.changes) > 0;
  }

  markExpired(id: string): void {
    this.#db.prepare("UPDATE uploads SET status = 'expired' WHERE id = ? AND status = 'pending'").run(id);
  }

  /** 找出已过期但仍是 pending 的 Upload（供清理任务使用）。 */
  findExpiredPending(now = Date.now()): UploadRow[] {
    return asRows<UploadRow>(
      this.#db.prepare("SELECT * FROM uploads WHERE status = 'pending' AND expires_at < ?").all(now),
    );
  }
}
