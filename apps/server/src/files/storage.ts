import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 文件磁盘存储（对应实施计划 §11：「文件名不得直接作为磁盘路径」）。
 *
 * 布局：
 *   <DATA_DIR>/files/<file-id>/content              —— 已完成文件的内容
 *   <DATA_DIR>/files/uploads/<upload-id>/<part-id>  —— 分片上传的每个分片
 *
 * 目录名一律用系统生成的 id（UUID），原始文件名只入库、绝不拼进路径，
 * 避免路径穿越（`../`）与非法文件名字符问题。
 */
export class FileStorage {
  readonly #root: string;

  constructor(dataDir: string) {
    this.#root = join(dataDir, 'files');
  }

  #fileDir(fileId: string): string {
    return join(this.#root, fileId);
  }

  #uploadDir(uploadId: string): string {
    return join(this.#root, 'uploads', uploadId);
  }

  writeFileContent(fileId: string, content: Buffer): void {
    const dir = this.#fileDir(fileId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'content'), content);
  }

  readFileContent(fileId: string): Buffer {
    return readFileSync(join(this.#fileDir(fileId), 'content'));
  }

  deleteFile(fileId: string): void {
    rmSync(this.#fileDir(fileId), { recursive: true, force: true });
  }

  writeUploadPart(uploadId: string, partId: string, content: Buffer): void {
    const dir = this.#uploadDir(uploadId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, partId), content);
  }

  readUploadPart(uploadId: string, partId: string): Buffer {
    return readFileSync(join(this.#uploadDir(uploadId), partId));
  }

  deleteUpload(uploadId: string): void {
    rmSync(this.#uploadDir(uploadId), { recursive: true, force: true });
  }
}

export function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}
