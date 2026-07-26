import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * 模型目录。
 *
 * model 值原样透传给上游，容器不改写、不造别名（护栏 §1.4）。这份目录只用于
 * `/v1/models` 展示与 Codex 端选择，不参与任何路由决策。
 * 允许通过 MODELS_FILE 覆盖，便于运维更新而不改镜像。
 */

export interface ModelEntry {
  id: string;
  object: 'model';
  created?: number;
  owned_by: string;
}

export interface ModelList {
  object: 'list';
  data: ModelEntry[];
}

const FALLBACK: ModelList = {
  object: 'list',
  data: [{ id: 'gpt-5-codex', object: 'model', owned_by: 'm365-codex' }],
};

function defaultModelsPath(): string {
  // 编译后位于 apps/server/dist/responses/models.js，仓库根的 config 在 ../../../../config
  return fileURLToPath(new URL('../../../../config/models.json', import.meta.url));
}

export function loadModels(path = process.env.MODELS_FILE ?? defaultModelsPath()): ModelList {
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as { data?: unknown };
    if (!Array.isArray(parsed.data)) return FALLBACK;
    const data = parsed.data
      .filter((entry): entry is ModelEntry => typeof entry === 'object' && entry !== null && 'id' in entry)
      .map((entry) => ({
        id: String(entry.id),
        object: 'model' as const,
        owned_by: entry.owned_by ?? 'm365-codex',
        ...(entry.created === undefined ? {} : { created: entry.created }),
      }));
    return { object: 'list', data };
  } catch {
    return FALLBACK;
  }
}
