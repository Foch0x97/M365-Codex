import { describe, expect, it } from 'vitest';
import { openDatabase, runMigrations, type Database } from '../src/db/index.js';
import { MIGRATIONS } from '../src/db/migrations.js';

/**
 * 迁移 v8：放宽 responses 表的 UNIQUE (api_key_id, idempotency_key) 约束（§18）。
 *
 * 背景：M003 建表时把这条唯一约束直接放在 responses 表上，是"完整语义在 M7"之前
 * 的占位；M7 把幂等的唯一性保证收敛到独立的 idempotency_keys 表后，这条表级约束
 * 反而会跟"流式请求执行完释放键、同键可重新执行"冲突（第二次 INSERT 撞见旧约束）。
 * 这里验证：升级路径保留旧数据、外键引用不受影响，且约束确实被放宽。
 */

function seedUpToV7(db: Database, apiKeyId: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO api_keys (id, name, prefix, salt, hash, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(apiKeyId, '测试 Key', 'sk-test', 'salt', 'hash', now);
  db.prepare(
    `INSERT INTO responses (
       id, api_key_id, status, requested_model, previous_response_id, idempotency_key,
       tool_round, tool_calls_total, created_at, updated_at
     ) VALUES (?, ?, 'completed', 'gpt-5-codex', NULL, ?, 0, 0, ?, ?)`,
  ).run('resp_old_1', apiKeyId, 'idem-legacy', now, now);
  db.prepare(
    `INSERT INTO tool_calls (id, response_id, call_id, name, status, side_effect, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'completed', 0, ?, ?)`,
  ).run('tc_1', 'resp_old_1', 'call_1', 'shell', now, now);
  db.prepare(
    `INSERT INTO conversation_bindings (response_id, account_id, upstream_conversation_ref, created_at)
     VALUES (?, NULL, NULL, ?)`,
  ).run('resp_old_1', now);
}

describe('迁移 v8：放宽 responses 的幂等键唯一约束', () => {
  it('升级后旧数据（含关联的 tool_calls、conversation_bindings）原样保留', () => {
    const db = openDatabase(':memory:');
    // 先跑到 v7（不含 v8），再手动插入模拟旧数据
    const v7Only = MIGRATIONS.filter((m) => m.version <= 7);
    runMigrations(db, v7Only);
    seedUpToV7(db, 'ak_1');

    // 再补上 v8
    runMigrations(db, MIGRATIONS);

    const response = db.prepare('SELECT * FROM responses WHERE id = ?').get('resp_old_1') as {
      idempotency_key: string;
      status: string;
    };
    expect(response.idempotency_key).toBe('idem-legacy');
    expect(response.status).toBe('completed');

    const toolCall = db.prepare('SELECT * FROM tool_calls WHERE id = ?').get('tc_1') as {
      response_id: string;
    };
    expect(toolCall.response_id).toBe('resp_old_1');

    const binding = db
      .prepare('SELECT * FROM conversation_bindings WHERE response_id = ?')
      .get('resp_old_1') as { response_id: string } | undefined;
    expect(binding).toBeDefined();

    db.close();
  });

  it('升级后同一个 (api_key_id, idempotency_key) 允许出现第二条记录', () => {
    const db = openDatabase(':memory:');
    runMigrations(db);
    const now = Date.now();
    db.prepare(
      `INSERT INTO api_keys (id, name, prefix, salt, hash, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('ak_2', '测试 Key 2', 'sk-test2', 'salt', 'hash', now);

    db.prepare(
      `INSERT INTO responses (
         id, api_key_id, status, requested_model, idempotency_key, tool_round, tool_calls_total, created_at, updated_at
       ) VALUES (?, ?, 'completed', 'gpt-5-codex', 'same-key', 0, 0, ?, ?)`,
    ).run('resp_a', 'ak_2', now, now);

    expect(() =>
      db
        .prepare(
          `INSERT INTO responses (
             id, api_key_id, status, requested_model, idempotency_key, tool_round, tool_calls_total, created_at, updated_at
           ) VALUES (?, ?, 'completed', 'gpt-5-codex', 'same-key', 0, 0, ?, ?)`,
        )
        .run('resp_b', 'ak_2', now, now),
    ).not.toThrow();

    db.close();
  });

  it('迁移后 responses 表仍保留按 api_key_id、status 的索引（查询路径不退化）', () => {
    const db = openDatabase(':memory:');
    runMigrations(db);
    const indexes = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'responses'").all() as {
        name: string;
      }[]
    ).map((row) => row.name);
    expect(indexes).toEqual(expect.arrayContaining(['idx_responses_api_key', 'idx_responses_status']));
    db.close();
  });
});
