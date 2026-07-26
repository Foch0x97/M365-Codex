import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LATEST_SCHEMA_VERSION, MIGRATIONS, type Migration } from './migrations.js';

export { LATEST_SCHEMA_VERSION, MIGRATIONS };
export type { Migration };

/** SQLite 句柄类型别名，便于后续替换实现。 */
export type Database = DatabaseSync;

export const DB_FILE_NAME = 'm365-codex.sqlite';

export class DatabaseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DatabaseError';
  }
}

/** 由数据目录推导数据库文件路径。`:memory:` 直接透传，供测试使用。 */
export function resolveDatabasePath(dataDir: string): string {
  return dataDir === ':memory:' ? ':memory:' : join(dataDir, DB_FILE_NAME);
}

/**
 * 打开数据库并设置 WAL 等 pragma。
 * 目录不存在时自动创建，避免容器首次挂载空卷启动失败。
 */
export function openDatabase(path: string): Database {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  return db;
}

function ensureMigrationTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
}

/** 当前已应用的最高迁移版本；未初始化时返回 0。 */
export function currentSchemaVersion(db: Database): number {
  ensureMigrationTable(db);
  const result = asRow<{ version: number | null }>(
    db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get(),
  );
  return result?.version ?? 0;
}

export interface MigrationResult {
  applied: number[];
  schemaVersion: number;
}

/**
 * 按版本顺序执行未应用的迁移，整体包在一个事务里。
 * 任何一条失败都会回滚，不会留下半截 schema。
 */
export function runMigrations(db: Database, migrations: readonly Migration[] = MIGRATIONS): MigrationResult {
  ensureMigrationTable(db);
  const startVersion = currentSchemaVersion(db);
  const pending = [...migrations]
    .filter((migration) => migration.version > startVersion)
    .sort((a, b) => a.version - b.version);

  if (pending.length === 0) {
    return { applied: [], schemaVersion: startVersion };
  }

  const record = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const migration of pending) {
      db.exec(migration.sql);
      record.run(migration.version, migration.name, Date.now());
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw new DatabaseError(`数据库迁移失败，已回滚到 v${startVersion}`, { cause: error });
  }

  return {
    applied: pending.map((migration) => migration.version),
    schemaVersion: currentSchemaVersion(db),
  };
}

/**
 * node:sqlite 返回的是 `Record<string, SQLOutputValue>`，与业务行类型没有结构重叠，
 * 直接断言会被 TS 拒绝。这两个helper 把「查询结果 → 行类型」的转换集中到一处，
 * 避免在各 repo 里散落 `as unknown as`。
 */
export function asRows<T>(result: unknown): T[] {
  return result as T[];
}

export function asRow<T>(result: unknown): T | undefined {
  return result as T | undefined;
}

/** 判断数据库是否可写：readyz 用它区分「只读挂载」这类部署错误。 */
export function checkWritable(db: Database): { ok: boolean; detail: string } {
  try {
    db.exec('CREATE TABLE IF NOT EXISTS _write_probe (id INTEGER PRIMARY KEY)');
    db.exec('DELETE FROM _write_probe');
    return { ok: true, detail: '数据库可写' };
  } catch (error) {
    return { ok: false, detail: `数据库不可写：${(error as Error).message}` };
  }
}
