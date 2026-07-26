import { Buffer } from 'node:buffer';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { ApiError } from '@m365-codex/shared';
import type { Database } from '../db/index.js';
import { DB_FILE_NAME, LATEST_SCHEMA_VERSION } from '../db/index.js';
import { packArchive, unpackArchive, type ArchiveEntry } from './archive.js';

/**
 * 备份与恢复（对应实施计划 §15.4）。
 *
 * 备份包是一个标准 tar.gz，内含：
 *   manifest.json   —— 版本、schema 版本、主密钥版本、生成时间、内容清单
 *   db.sqlite       —— 用 `VACUUM INTO` 生成的一致性快照（不是直接拷贝正在写的库）
 *   files/<id>/…    —— 上传文件的原始内容（可选）
 *
 * **主密钥不在备份包里**：库中的 Token 仍是 AES-256-GCM 密文，换一台机器恢复时
 * 必须提供同一个 `M365_CODEX_MASTER_KEY` 才解得开。manifest 里只记录密钥**版本号**
 * 用于校验，绝不写入密钥本身。这样备份包泄露也不等于 Token 泄露。
 */

export const BACKUP_FORMAT_VERSION = 1;

export interface BackupManifest {
  format_version: number;
  app_version: string;
  schema_version: number;
  master_key_version: number;
  created_at: number;
  includes_files: boolean;
  file_count: number;
}

export interface BackupResult {
  archive: Buffer;
  manifest: BackupManifest;
}

export interface BackupDeps {
  db: Database;
  dataDir: string;
  appVersion: string;
  masterKeyVersion: number;
}

/** 列出 files 目录下的所有普通文件，返回归档内相对路径。 */
function listFiles(root: string): { archivePath: string; absolute: string }[] {
  if (!existsSync(root)) return [];
  const out: { archivePath: string; absolute: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = relative(root, absolute).split(sep).join('/');
      out.push({ archivePath: `files/${rel}`, absolute });
    }
  };
  walk(root);
  return out;
}

export class BackupService {
  readonly #deps: BackupDeps;

  constructor(deps: BackupDeps) {
    this.#deps = deps;
  }

  /**
   * 生成备份包。
   * 数据库用 VACUUM INTO 出一份一致性快照——直接读正在写的库文件可能拿到撕裂状态。
   */
  create(options: { includeFiles?: boolean } = {}, now = Date.now()): BackupResult {
    const includeFiles = options.includeFiles ?? true;
    const { dataDir } = this.#deps;

    const tmpDir = join(dataDir, 'backup-tmp');
    mkdirSync(tmpDir, { recursive: true });
    const snapshotPath = join(tmpDir, `snapshot-${now}.sqlite`);
    rmSync(snapshotPath, { force: true });

    try {
      // VACUUM INTO 的路径要转义单引号，虽然这里是自造路径，仍不省这一步
      this.#deps.db.exec(`VACUUM INTO '${snapshotPath.replace(/'/g, "''")}'`);
      const dbSnapshot = readFileSync(snapshotPath);

      const files = includeFiles ? listFiles(join(dataDir, 'files')) : [];
      const manifest: BackupManifest = {
        format_version: BACKUP_FORMAT_VERSION,
        app_version: this.#deps.appVersion,
        schema_version: LATEST_SCHEMA_VERSION,
        master_key_version: this.#deps.masterKeyVersion,
        created_at: now,
        includes_files: includeFiles,
        file_count: files.length,
      };

      const entries: ArchiveEntry[] = [
        { path: 'manifest.json', content: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') },
        { path: 'db.sqlite', content: dbSnapshot },
        ...files.map((f) => ({ path: f.archivePath, content: readFileSync(f.absolute) })),
      ];

      return { archive: packArchive(entries, now), manifest };
    } finally {
      rmSync(snapshotPath, { force: true });
    }
  }

  /**
   * 校验备份包并把内容落到目标目录。
   *
   * 恢复是**替换式**的，且必须在服务重启后才生效——正在运行的进程持有旧库的连接。
   * 因此这里只负责写盘与校验，重启由调用方（管理接口）提示管理员执行。
   */
  restore(archive: Buffer, now = Date.now()): BackupManifest {
    let entries: ArchiveEntry[];
    try {
      entries = unpackArchive(archive);
    } catch (error) {
      // gzip/tar 解析失败（比如上传了个随便的文件）是用户输入问题，不是服务端故障，
      // 不能让它变成 500——那样调用方看不出「我传错了」还是「服务坏了」
      throw ApiError.badRequest(
        `备份包无法解析（不是合法的 tar.gz）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const manifestEntry = entries.find((e) => e.path === 'manifest.json');
    if (manifestEntry === undefined) {
      throw ApiError.badRequest('备份包缺少 manifest.json，不是本项目生成的备份');
    }

    let manifest: BackupManifest;
    try {
      manifest = JSON.parse(manifestEntry.content.toString('utf8')) as BackupManifest;
    } catch {
      throw ApiError.badRequest('备份包的 manifest.json 无法解析');
    }

    if (manifest.format_version !== BACKUP_FORMAT_VERSION) {
      throw ApiError.badRequest(
        `备份包格式版本为 ${manifest.format_version}，当前只支持 ${BACKUP_FORMAT_VERSION}`,
      );
    }
    if (manifest.schema_version > LATEST_SCHEMA_VERSION) {
      // 来自更新版本的备份可能含本版本不认识的表结构，恢复了也跑不起来
      throw ApiError.badRequest(
        `备份包的数据库结构版本（v${manifest.schema_version}）高于当前程序支持的 v${LATEST_SCHEMA_VERSION}，请先升级程序再恢复`,
      );
    }
    if (manifest.master_key_version !== this.#deps.masterKeyVersion) {
      throw ApiError.badRequest(
        `备份包用的是主密钥版本 v${manifest.master_key_version}，当前是 v${this.#deps.masterKeyVersion}；` +
          '恢复后 Token 将无法解密，请先切回对应版本的主密钥',
      );
    }

    const dbEntry = entries.find((e) => e.path === 'db.sqlite');
    if (dbEntry === undefined) {
      throw ApiError.badRequest('备份包缺少数据库快照');
    }

    const { dataDir } = this.#deps;
    mkdirSync(dataDir, { recursive: true });

    // 旧库先改名留底，恢复出问题时还能人工找回
    const dbPath = join(dataDir, DB_FILE_NAME);
    if (existsSync(dbPath)) {
      writeFileSync(`${dbPath}.replaced-${now}`, readFileSync(dbPath));
    }
    writeFileSync(dbPath, dbEntry.content);

    // 文件内容整体替换：备份里没有的文件不保留，避免恢复后出现「库里没有、盘上还在」的孤儿
    const filesRoot = join(dataDir, 'files');
    if (manifest.includes_files) {
      rmSync(filesRoot, { recursive: true, force: true });
      for (const entry of entries) {
        if (!entry.path.startsWith('files/')) continue;
        const target = join(filesRoot, ...entry.path.slice('files/'.length).split('/'));
        mkdirSync(join(target, '..'), { recursive: true });
        writeFileSync(target, entry.content);
      }
    }

    return manifest;
  }

  /** 数据占用概览，供管理界面显示。 */
  usage(): { dbBytes: number; filesBytes: number; fileCount: number } {
    const dbPath = join(this.#deps.dataDir, DB_FILE_NAME);
    const dbBytes = existsSync(dbPath) ? statSync(dbPath).size : 0;
    const files = listFiles(join(this.#deps.dataDir, 'files'));
    const filesBytes = files.reduce((sum, f) => sum + statSync(f.absolute).size, 0);
    return { dbBytes, filesBytes, fileCount: files.length };
  }
}
