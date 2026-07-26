/**
 * `NO_PROXY` 排除判断。
 *
 * 背景：`config/index.ts` 解析并展示了 `NO_PROXY`，但此前从未在决定是否挂代理前
 * 拿目标主机比对过——`HTTPS_PROXY`/`HTTP_PROXY` 真接到了出口代理上，`NO_PROXY`
 * 却只是摆设。这比“没有这个功能”更糟：运维照 `.env.example` 的文档配置
 * `NO_PROXY=xxx`，以为对应主机会直连，实际上照样走代理。
 *
 * 语义对齐 curl/Node 生态里 `NO_PROXY` 的通行约定：
 * - 逗号或空白分隔多个条目；
 * - `*` 单独出现表示全部主机都不走代理；
 * - 条目可以是裸域名（`example.com`——同时匹配自身与任意子域名，这是绝大多数
 *   实现的实际行为，不是字面意义上的"仅精确匹配"）、显式子域名通配
 *   （`*.example.com`）、前导点（`.example.com`，与 `*.example.com` 等价）、
 *   IP 字面量、`localhost`；
 * - 条目可以带端口，比较时忽略端口（是否命中只看主机名）；
 * - 大小写不敏感；
 * - 后缀匹配按点边界比较：`notexample.com` 不会被条目 `example.com` 命中。
 */

/** 判断某个目标主机名是否应当绕开代理（命中 NO_PROXY 列表）。 */
export function shouldBypassProxy(hostname: string, noProxy: string | null | undefined): boolean {
  if (noProxy == null) return false;
  const host = normalizeHost(hostname);
  if (host === '') return false;

  for (const rawEntry of splitEntries(noProxy)) {
    if (rawEntry === '*') return true;
    const entry = stripEntryPort(normalizeHost(rawEntry));
    if (entry === '') continue;
    if (matchesEntry(host, entry)) return true;
  }
  return false;
}

/** 从目标 URL 取主机名；解析失败时返回 null（调用方应视为不命中 NO_PROXY，不阻断请求）。 */
export function hostnameFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function splitEntries(noProxy: string): string[] {
  return noProxy
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

function normalizeHost(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * 去掉条目里可能带的端口号。只在“恰好一个冒号”时按端口处理，避免误伤
 * IPv6 字面量（含多个冒号）——上游/OAuth 目标目前都不是 IPv6，这里从简。
 */
function stripEntryPort(entry: string): string {
  const idx = entry.lastIndexOf(':');
  if (idx <= 0) return entry;
  if (entry.indexOf(':') !== idx) return entry;
  return entry.slice(0, idx);
}

function matchesEntry(host: string, entryRaw: string): boolean {
  let entry = entryRaw;
  if (entry.startsWith('*.')) entry = entry.slice(1); // '*.example.com' -> '.example.com'
  if (entry.startsWith('.')) {
    return host === entry.slice(1) || host.endsWith(entry);
  }
  // 裸域名同时匹配自身与子域名；点边界比较保证 notexample.com 不会命中 example.com
  return host === entry || host.endsWith(`.${entry}`);
}
