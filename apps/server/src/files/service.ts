import { randomUUID } from 'node:crypto';
import { ApiError } from '@m365-codex/shared';
import type { FilesConfig } from '../config/index.js';
import type { FileRepository, FileRow } from '../repo/files.js';
import { classifyFile } from './classify.js';
import { extractText } from './extract.js';
import type { FileStorage } from './storage.js';
import { sha256Hex } from './storage.js';

/**
 * 文件服务：把「校验 → 分类 → 提取 → 落盘 → 入库」串起来（对应实施计划 §11、§M6）。
 *
 * 归属与限额在这一层统一把关，路由与 Uploads 完成流程都复用同一入口，
 * 避免规则在两处各写一份、慢慢漂移。
 */

export interface FilesServiceDeps {
  files: FileRepository;
  storage: FileStorage;
  config: FilesConfig;
}

export interface IngestFileParams {
  apiKeyId: string;
  filename: string;
  purpose: string;
  declaredMimeType: string | null;
  content: Buffer;
}

export class FilesService {
  readonly #deps: FilesServiceDeps;

  constructor(deps: FilesServiceDeps) {
    this.#deps = deps;
  }

  /** 单文件大小检查，供路由在读取 multipart 内容后立即调用，尽早拒绝超大请求。 */
  assertFileSize(bytes: number): void {
    if (bytes > this.#deps.config.maxFileBytes) {
      throw new ApiError({
        type: 'invalid_request_error',
        status: 413,
        message: `文件大小 ${bytes} 字节，超过单文件上限 ${this.#deps.config.maxFileBytes} 字节`,
      });
    }
  }

  /** 累计存储配额检查：当前占用 + 本次新增是否超过单 Key 上限。 */
  assertQuota(apiKeyId: string, additionalBytes: number): void {
    const used = this.#deps.files.sumActiveBytes(apiKeyId);
    const limit = this.#deps.config.maxTotalBytesPerKey;
    if (used + additionalBytes > limit) {
      throw new ApiError({
        type: 'invalid_request_error',
        status: 413,
        message: `该 API Key 累计存储已占用 ${used} 字节，本次 ${additionalBytes} 字节将超过上限 ${limit} 字节`,
      });
    }
  }

  /** 校验、分类、提取、落盘、入库的完整流程。 */
  async ingest(params: IngestFileParams): Promise<FileRow> {
    this.assertFileSize(params.content.length);
    this.assertQuota(params.apiKeyId, params.content.length);

    const { kind, trusted } = classifyFile(params.filename, params.declaredMimeType, params.content);
    const extraction = await extractText(params.content, kind, trusted);

    const fileId = `file_${randomUUID().replaceAll('-', '')}`;
    const now = Date.now();
    const expiresAt = this.#deps.config.retentionMs > 0 ? now + this.#deps.config.retentionMs : null;

    this.#deps.storage.writeFileContent(fileId, params.content);

    return this.#deps.files.create(
      {
        id: fileId,
        apiKeyId: params.apiKeyId,
        filename: params.filename,
        purpose: params.purpose,
        mimeType: params.declaredMimeType ?? 'application/octet-stream',
        kind,
        bytes: params.content.length,
        sha256: sha256Hex(params.content),
        status: extraction.ok || extraction.skipped ? 'processed' : 'error',
        extractedText: extraction.ok ? extraction.text : null,
        extractionNote: extraction.ok ? null : extraction.note,
        expiresAt,
      },
      now,
    );
  }

  list(apiKeyId: string, purpose?: string | null): FileRow[] {
    return this.#deps.files.listByApiKey(apiKeyId, purpose);
  }

  /** 找出属于该 Key 的文件；不存在或不属于该 Key 一律 404，不泄露存在性。 */
  getOwned(fileId: string, apiKeyId: string): FileRow {
    const row = this.#deps.files.findOwnedActive(fileId, apiKeyId);
    if (row === undefined) throw ApiError.notFound('文件不存在');
    return row;
  }

  getContent(fileId: string, apiKeyId: string): { row: FileRow; content: Buffer } {
    const row = this.getOwned(fileId, apiKeyId);
    return { row, content: this.#deps.storage.readFileContent(fileId) };
  }

  delete(fileId: string, apiKeyId: string): void {
    const deleted = this.#deps.files.softDelete(fileId, apiKeyId);
    if (!deleted) throw ApiError.notFound('文件不存在');
    this.#deps.storage.deleteFile(fileId);
  }

  /**
   * 供 Responses 的 `input_file` 使用：按 file-id 取已提取文本，且必须属于
   * 发起本次请求的 API Key——不允许跨 Key 引用别人的文件内容。
   * 返回 null 表示不存在、不属于该 Key，或未产出可用文本，由调用方决定报错文案。
   */
  resolveOwnedText(fileId: string, apiKeyId: string): { filename: string; text: string } | null {
    const row = this.#deps.files.findOwnedActive(fileId, apiKeyId);
    if (row === undefined || row.extracted_text === null) return null;
    return { filename: row.filename, text: row.extracted_text };
  }

  /**
   * 供 Responses 的 `input_image`（`UPSTREAM_IMAGE_INPUT=true` 时）使用：
   * 按 file-id 取原始内容并转成 data URL。只认已归类为图片的文件。
   */
  resolveOwnedImageDataUrl(fileId: string, apiKeyId: string): { dataUrl: string; filename: string } | null {
    const row = this.#deps.files.findOwnedActive(fileId, apiKeyId);
    if (row === undefined || row.kind !== 'image') return null;
    const content = this.#deps.storage.readFileContent(fileId);
    return { dataUrl: `data:${row.mime_type};base64,${content.toString('base64')}`, filename: row.filename };
  }
}
