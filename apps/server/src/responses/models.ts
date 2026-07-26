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

/**
 * 读取模型目录。
 *
 * 读不到时会退到只含一个模型的 FALLBACK，但**必须让调用方知道**——
 * 静默降级会让 `/v1/models` 少列模型而没人察觉（实测踩过：镜像漏拷 config/
 * 目录，线上只返回 1 个模型，而配置文件里有 3 个，排查了很久才发现）。
 * 传 `onFallback` 即可把原因接到日志上。
 */
export function loadModels(
  path = process.env.MODELS_FILE ?? defaultModelsPath(),
  onFallback?: (reason: string) => void,
): ModelList {
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as { data?: unknown };
    if (!Array.isArray(parsed.data)) {
      onFallback?.(`模型目录 ${path} 里没有 data 数组，已退回内置目录`);
      return FALLBACK;
    }
    const data = parsed.data
      .filter((entry): entry is ModelEntry => typeof entry === 'object' && entry !== null && 'id' in entry)
      .map((entry) => ({
        id: String(entry.id),
        object: 'model' as const,
        owned_by: entry.owned_by ?? 'm365-codex',
        ...(entry.created === undefined ? {} : { created: entry.created }),
      }));
    return { object: 'list', data };
  } catch (error) {
    onFallback?.(`读取模型目录 ${path} 失败（${(error as Error).message}），已退回内置目录`);
    return FALLBACK;
  }
}
