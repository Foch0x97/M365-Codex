import type { FileRepository, UploadRepository } from '../repo/files.js';
import type { FileStorage } from './storage.js';

/**
 * 过期文件与未完成 Upload 的清理（对应实施计划 §11：「未完成的 Upload、过期文件
 * 自动清理」）。
 *
 * M6 只把清理逻辑做成可独立调用、可单测的纯函数；定时器注册留给 M7——避免
 * 在没有 WebUI/运维面板可看执行历史之前，先悄悄跑一个谁都不知道存在的后台任务。
 */

export interface CleanupDeps {
  files: FileRepository;
  uploads: UploadRepository;
  storage: FileStorage;
}

export interface CleanupResult {
  expiredFiles: number;
  expiredUploads: number;
}

/** 清理已过保留期但尚未删除的文件：软删除数据库行 + 删除磁盘内容。 */
export function cleanupExpiredFiles(deps: CleanupDeps, now = Date.now()): number {
  const expired = deps.files.findExpired(now);
  for (const file of expired) {
    const deleted = deps.files.softDelete(file.id, file.api_key_id, now);
    // softDelete 具备幂等性：只有真正生效（未被并发清理过）才去动磁盘，
    // 避免并发清理任务重复删除同一份内容。
    if (deleted) deps.storage.deleteFile(file.id);
  }
  return expired.length;
}

/** 清理已过期仍处于 pending 的 Upload：标记 expired + 删除已收到的分片。 */
export function cleanupExpiredUploads(deps: CleanupDeps, now = Date.now()): number {
  const expired = deps.uploads.findExpiredPending(now);
  for (const upload of expired) {
    deps.uploads.markExpired(upload.id);
    deps.storage.deleteUpload(upload.id);
  }
  return expired.length;
}

/** 一次性跑完两类清理，供 M7 的定时器或运维手动触发调用。 */
export function runFilesCleanup(deps: CleanupDeps, now = Date.now()): CleanupResult {
  return {
    expiredFiles: cleanupExpiredFiles(deps, now),
    expiredUploads: cleanupExpiredUploads(deps, now),
  };
}
