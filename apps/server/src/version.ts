import { createRequire } from 'node:module';

/**
 * 应用版本号。
 *
 * 直接读 apps/server/package.json，而不是手写常量——手写的那份在 v0.5.0 上就漏更过，
 * `/healthz` 报了一个和实际发布版本不一致的号。npm version 会同时更新
 * 根 package.json 与各 workspace 的 package.json，这里跟着它走就不会再漂。
 */
const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version?: string };

export const APP_VERSION: string = pkg.version ?? '0.0.0';
