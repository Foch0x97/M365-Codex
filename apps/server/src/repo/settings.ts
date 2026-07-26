import { asRow, asRows, type Database } from '../db/index.js';

/**
 * 设置项的原始键值存取（对应实施计划 §M7、契约 §2.3）。
 *
 * 只做最基础的 KV 读写；分组、`source`/`editable`/`requires_restart` 的语义
 * 由上一层 `settings/service.ts` 负责，这里保持纯粹，方便单测。
 */

export interface SettingRow {
  key: string;
  value: string;
  updated_at: number;
}

export class SettingsRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  get(key: string): SettingRow | undefined {
    return asRow<SettingRow>(this.#db.prepare('SELECT * FROM settings WHERE key = ?').get(key));
  }

  getAll(): SettingRow[] {
    return asRows<SettingRow>(this.#db.prepare('SELECT * FROM settings ORDER BY key ASC').all());
  }

  /** 存的是 JSON 编码后的值，调用方负责序列化/反序列化。 */
  set(key: string, jsonValue: string, now = Date.now()): void {
    this.#db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, jsonValue, now);
  }

  delete(key: string): void {
    this.#db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  }
}
