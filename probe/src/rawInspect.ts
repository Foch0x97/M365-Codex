import type { RawMessage } from '../../apps/server/dist/adapter/protocol.js';

/**
 * 从原始帧里按键名模式做启发式检索（用量、模型名等 §3.1 第 18/20/21 项）。
 *
 * 真实字段名未知，只能广度优先扫描键名。数值/布尔值本身是「结构化元数据」，
 * 不算「内容」，可以直接保留在证据里；字符串值仍按 `evidence.ts` 的规则处理
 * （调用方决定是否需要把命中的字符串也放进 allowlist）。
 */
export interface FieldHit {
  path: string;
  value: unknown;
}

const MAX_HITS = 10;

export function findFieldsByKeyPattern(messages: readonly RawMessage[], pattern: RegExp): FieldHit[] {
  const hits: FieldHit[] = [];
  for (const message of messages) {
    walk(message, '$', pattern, hits);
    if (hits.length >= MAX_HITS) break;
  }
  return hits.slice(0, MAX_HITS);
}

function walk(value: unknown, path: string, pattern: RegExp, hits: FieldHit[], depth = 0): void {
  if (hits.length >= MAX_HITS || depth > 8) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${path}[${index}]`, pattern, hits, depth + 1));
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    const nextPath = `${path}.${key}`;
    if (pattern.test(key)) {
      hits.push({ path: nextPath, value: typeof val === 'string' ? `<string:${val.length}>` : val });
      if (hits.length >= MAX_HITS) return;
    }
    walk(val, nextPath, pattern, hits, depth + 1);
  }
}
