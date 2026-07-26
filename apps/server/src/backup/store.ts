import type { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 备份包在磁盘上的管理（对应实施计划 §15.4、契约 §三）。
 *
 * `BackupService`（`backup/service.ts`）只管「怎么生成/校验/恢复一个包」，
 * 不关心「这些包放在哪、叫什么、什么时候该删」——那是这里的事：
 * `<DATA_DIR>/backups/<id>.tar.gz`，`id` 由本类生成，不接受外部输入拼路径，
 * 从根本上避免 `GET /admin/backup/:id/download` 的路径穿越。
 */

export interface BackupFileInfo {
  id: string;
  bytes: number;
  created_at: number;
}

/** id 只能是本类生成的形状：`bkp_<毫秒时间戳>_<8位十六进制>`。 */
const ID_PATTERN = /^bkp_[0-9]+_[a-f0-9]{8}$/;

export function isValidBackupId(id: string): boolean {
  return ID_PATTERN.test(id);
}

export class BackupStore {
  readonly #dir: string;

  constructor(dataDir: string) {
    this.#dir = join(dataDir, 'backups');
  }

  get dir(): string {
    return this.#dir;
  }

  /** 生成新 id 并落盘，返回该包的元信息。 */
  save(content: Buffer, now = Date.now()): BackupFileInfo {
    mkdirSync(this.#dir, { recursive: true });
    const id = `bkp_${now}_${randomBytes(4).toString('hex')}`;
    writeFileSync(this.#path(id), content);
    return { id, bytes: content.byteLength, created_at: now };
  }

  /** 按创建时间倒序列出全部备份包。 */
  list(): BackupFileInfo[] {
    if (!existsSync(this.#dir)) return [];
    const items: BackupFileInfo[] = [];
    for (const entry of readdirSync(this.#dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.tar.gz')) continue;
      const id = entry.name.slice(0, -'.tar.gz'.length);
      if (!isValidBackupId(id)) continue; // 目录里混进了别的文件，忽略而不是报错
      const stat = statSync(join(this.#dir, entry.name));
      items.push({ id, bytes: stat.size, created_at: stat.mtimeMs });
    }
    return items.sort((a, b) => b.created_at - a.created_at);
  }

  /** 读取指定 id 的内容；id 形状不合法或文件不存在都返回 undefined。 */
  read(id: string): Buffer | undefined {
    if (!isValidBackupId(id)) return undefined;
    const path = this.#path(id);
    if (!existsSync(path)) return undefined;
    return readFileSync(path);
  }

  delete(id: string): boolean {
    if (!isValidBackupId(id)) return false;
    const path = this.#path(id);
    if (!existsSync(path)) return false;
    rmSync(path, { force: true });
    return true;
  }

  /** 只保留最近 retentionCount 份，删掉更旧的；返回删除数量（供清理任务上报）。 */
  prune(retentionCount: number): number {
    const items = this.list(); // 已按时间倒序
    const toDelete = items.slice(retentionCount);
    for (const item of toDelete) this.delete(item.id);
    return toDelete.length;
  }

  #path(id: string): string {
    return join(this.#dir, `${id}.tar.gz`);
  }
}
