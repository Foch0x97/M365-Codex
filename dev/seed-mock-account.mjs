#!/usr/bin/env node
/**
 * 往数据库里放一个**假的** Microsoft 账号，只用于对着模拟上游做端到端验收。
 *
 * 为什么需要它：账号只能经 PKCE 授权流程添加（这是有意的安全约束），而 PKCE 需要
 * 真实 Microsoft 登录。要在没有真实账号的情况下验证网关本身（Responses/SSE/工具循环/
 * 附件），就得有一条可被调度器选中的账号记录。
 *
 * 安全说明：写进去的 access/refresh token 是明摆着的假串（`mock-*`），对真实 Microsoft
 * 服务毫无意义；必须配合 UPSTREAM_WS_BASE 指向模拟上游使用。**不要在生产库上运行。**
 *
 * 用法（本地，先 npm run build）：
 *   M365_CODEX_MASTER_KEY=... node dev/seed-mock-account.mjs --db ./data/m365-codex.db
 * 用法（容器内）：
 *   node /app/dev/seed-mock-account.mjs --db /data/m365-codex.db --dist /app/apps/server/dist
 */

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { Buffer } from 'node:buffer';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

const dbPath = arg('db', './data/m365-codex.db');
const distDir = resolve(arg('dist', './apps/server/dist'));
const count = Number(arg('count', '1'));

const masterKeyRaw = process.env.M365_CODEX_MASTER_KEY;
if (!masterKeyRaw) {
  console.error('缺少 M365_CODEX_MASTER_KEY，无法加密写入 Token');
  process.exit(1);
}
const masterKey = Buffer.from(masterKeyRaw, 'base64');
if (masterKey.byteLength !== 32) {
  console.error('主密钥解码后不是 32 字节');
  process.exit(1);
}

const load = (rel) => import(pathToFileURL(resolve(distDir, rel)).href);

const { openDatabase, runMigrations } = await load('db/index.js');
const { Cryptor } = await load('crypto/index.js');
const { AccountRepository } = await load('repo/accounts.js');

const db = openDatabase(dbPath);
runMigrations(db);

const accounts = new AccountRepository(db, new Cryptor(masterKey, Number(process.env.MASTER_KEY_VERSION ?? 1)));

for (let i = 1; i <= count; i += 1) {
  const view = accounts.upsert({
    tid: 'mock-tenant',
    oid: `mock-object-${i}`,
    email: `mock${i}@upstream.example.invalid`,
    displayName: `模拟账号 ${i}`,
    source: 'oauth',
    tokens: {
      accessToken: `mock-access-token-${i}`,
      refreshToken: `mock-refresh-token-${i}`,
      expiresAt: Date.now() + 24 * 3600 * 1000,
    },
  });
  accounts.forceStatus(view.id, 'online');
  console.log(`已写入假账号 ${view.id}（${view.email}）`);
}

db.close();
console.log('完成。请确认 UPSTREAM_WS_BASE 指向模拟上游，否则这些假 Token 对真实上游无效。');
