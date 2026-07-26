import { describe, expect, it } from 'vitest';
import {
  checkWritable,
  currentSchemaVersion,
  LATEST_SCHEMA_VERSION,
  openDatabase,
  resolveDatabasePath,
  runMigrations,
  DatabaseError,
} from '../src/db/index.js';

describe('resolveDatabasePath', () => {
  it('内存数据库直接透传', () => {
    expect(resolveDatabasePath(':memory:')).toBe(':memory:');
  });

  it('普通目录拼出数据库文件名', () => {
    expect(resolveDatabasePath('/data')).toMatch(/m365-codex\.sqlite$/);
  });
});

describe('runMigrations', () => {
  it('全新数据库迁移到最新版本', () => {
    const db = openDatabase(':memory:');
    const result = runMigrations(db);
    expect(result.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(result.applied).toContain(1);
    db.close();
  });

  it('重复执行是幂等的', () => {
    const db = openDatabase(':memory:');
    runMigrations(db);
    const second = runMigrations(db);
    expect(second.applied).toEqual([]);
    expect(second.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    db.close();
  });

  it('迁移后核心表存在', () => {
    const db = openDatabase(':memory:');
    runMigrations(db);
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((row) => row.name);
    expect(tables).toEqual(
      expect.arrayContaining(['schema_migrations', 'settings', 'api_keys', 'admin_sessions', 'audit_logs']),
    );
    db.close();
  });

  it('迁移失败时整体回滚，不留半截 schema', () => {
    const db = openDatabase(':memory:');
    expect(() =>
      runMigrations(db, [
        { version: 1, name: 'ok', sql: 'CREATE TABLE good (id INTEGER PRIMARY KEY);' },
        { version: 2, name: 'broken', sql: 'CREATE TABLE 语法错误 ((;' },
      ]),
    ).toThrow(DatabaseError);
    expect(currentSchemaVersion(db)).toBe(0);
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((row) => row.name);
    expect(tables).not.toContain('good');
    db.close();
  });
});

describe('checkWritable', () => {
  it('可写数据库返回 ok', () => {
    const db = openDatabase(':memory:');
    runMigrations(db);
    expect(checkWritable(db).ok).toBe(true);
    db.close();
  });
});
