import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { FALLBACK_CONSOLE_HTML } from './fallbackConsole.js';

/**
 * 管理界面的静态托管（对应实施计划 §14）。
 *
 * 页面挂在 `/ui/` 下，和 `/admin/*` 的 JSON 管理 API 分开——同一前缀下一半是页面
 * 一半是 JSON，后续加接口很容易撞路径。
 *
 * 没有引入 @fastify/static：这里只要「读文件 + 按扩展名给 Content-Type + 目录逃逸
 * 防护 + SPA 回落」这几件事，自己写四十行比多一个依赖划算。
 *
 * 构建产物不存在时（例如只构建了服务端），回落到内置的**临时控制台**页面，
 * 保证管理员任何时候都进得去、能加账号、能建 Key。构建产物一旦存在就自动接管。
 */

const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/** 定位 apps/web/dist：dist/routes/ui.js 与源码 src/routes/ui.ts 的相对深度一致。 */
function resolveWebDist(): string {
  const here = fileURLToPath(new URL('.', import.meta.url));
  return resolve(here, '..', '..', '..', 'web', 'dist');
}

export function registerUiRoutes(app: FastifyInstance, options: { webDist?: string } = {}): void {
  const webDist = options.webDist ?? resolveWebDist();

  app.get('/', async (_request, reply) => {
    return reply.redirect('/ui/', 302);
  });

  app.get('/ui', async (_request, reply) => {
    return reply.redirect('/ui/', 302);
  });

  app.get<{ Params: { '*': string } }>('/ui/*', async (request, reply) => {
    const requested = request.params['*'] ?? '';

    if (!existsSync(join(webDist, 'index.html'))) {
      // 还没有前端构建产物：给内置的临时控制台
      return reply.type('text/html; charset=utf-8').send(FALLBACK_CONSOLE_HTML);
    }

    // 目录逃逸防护：拼完路径必须仍在 webDist 内
    const candidate = resolve(webDist, normalize(requested));
    const inside = candidate === webDist || candidate.startsWith(webDist + sep);
    const target = inside && requested !== '' && existsSync(candidate) ? candidate : join(webDist, 'index.html');

    const body = await readFile(target);
    const mime = MIME_BY_EXT[extname(target).toLowerCase()] ?? 'application/octet-stream';
    // 带哈希的资源可以长缓存，index.html 不行——否则改版后浏览器一直拿旧壳
    const cache = target.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable';
    return reply.type(mime).header('cache-control', cache).send(body);
  });
}
