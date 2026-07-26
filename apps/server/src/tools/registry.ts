import { ApiError } from '@m365-codex/shared';
import Ajv2020Cjs from 'ajv/dist/2020.js';
import type { ToolDeclaration } from '../adapter/protocol.js';

// ajv 是 CJS，NodeNext 下默认导入绑定命名空间，真正的类在 .default 上
const Ajv2020 = Ajv2020Cjs.default;

/**
 * 工具（函数）声明的解析、校验与参数校验（对应实施计划 §7.2、§7.3）。
 *
 * 接受 OpenAI Responses 的两种 function 工具写法：
 *   { type: 'function', name, description, parameters }        （扁平）
 *   { type: 'function', function: { name, description, parameters } }（嵌套）
 *
 * 参数用 JSON Schema 校验模型产出的工具调用参数；不合法时给出可读错误，
 * 供「最多两次参数修复」使用。
 */

export interface ParsedTool {
  name: string;
  description: string | null;
  parameters: Record<string, unknown> | null;
  /**
   * 是否可能产生副作用。默认 true（保守：从不自动跨账号重放任何工具调用）。
   * 工具定义里可用 `x_side_effect: false` 显式标为只读。
   */
  sideEffect: boolean;
}

/**
 * 参数校验失败的原因。三者的处置不同（§7.3）：
 * - `undeclared`  —— 调了没声明的工具，修复无果后**绝不发给客户端**；
 * - `invalid_json` —— 参数不是合法 JSON，修复无果后发出去客户端也解析不了，判失败；
 * - `schema`      —— JSON 合法但不满足工具 schema，修复无果后如实发出并记录告警。
 */
export type ValidationReason = 'undeclared' | 'invalid_json' | 'schema';

export interface ArgumentValidation {
  valid: boolean;
  reason?: ValidationReason;
  /** 人类可读的错误摘要，用于向模型请求修复 */
  errors: string[];
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/** 被跳过的工具：客户端声明了，但本网关执行不了（OpenAI 托管工具等）。 */
export interface SkippedTool {
  name: string;
  type: string;
  reason: string;
}

/**
 * 解析一个工具定义，返回**一个或多个** ParsedTool。
 *
 * 真实 Codex（v0.145）一次会发三种形态，这里都要认（2026-07-26 实测抓包）：
 *   { type:'function', name, description, strict, parameters }   —— 扁平 function
 *   { type:'function', function:{…} }                            —— 嵌套 function
 *   { type:'namespace', name, description, tools:[function…] }   —— 一组子工具（如 multi_agent_v1）
 * namespace 按其子工具**摊平**登记：模型仍按子工具原名调用，本网关只是把分组拆开。
 *
 * 其余类型（web_search / file_search / code_interpreter / image_generation…）是
 * OpenAI 托管工具，本项目执行不了（见 §24.3）。这类**跳过而不是报错**：
 * 直接 422 会让默认配置的 Codex 完全用不了，而跳过既不假装支持（工具不会出现在
 * 给上游的目录里，模型真去调也会被「未声明工具」挡下），又能通过 skipped 明确告知调用方。
 */
export function parseTool(raw: unknown, index: number, skipped?: SkippedTool[]): ParsedTool[] {
  const obj = asObject(raw);
  if (obj === null) {
    throw ApiError.badRequest(`tools[${index}] 不是对象`, `tools.${index}`);
  }

  const type = obj.type;

  if (type === 'namespace') {
    const nested = Array.isArray(obj.tools) ? obj.tools : [];
    return nested.flatMap((child, childIndex) => parseTool(child, childIndex, skipped));
  }

  if (type !== undefined && type !== 'function') {
    const typeLabel = typeof type === 'string' ? type : typeof type;
    const name = typeof obj.name === 'string' ? obj.name : typeLabel;
    skipped?.push({
      name,
      type: typeLabel,
      reason: '托管工具需要 OpenAI 后端执行，本网关不具备该能力',
    });
    return [];
  }

  const fn = asObject(obj.function) ?? obj;
  const name = fn.name;
  if (typeof name !== 'string' || name === '') {
    throw ApiError.badRequest(`tools[${index}] 缺少 function name`, `tools.${index}.name`);
  }

  const description = typeof fn.description === 'string' ? fn.description : null;
  const parameters = asObject(fn.parameters);
  const sideEffectHint = fn.x_side_effect ?? obj.x_side_effect;
  const sideEffect = sideEffectHint === false ? false : true;

  return [{ name, description, parameters, sideEffect }];
}

/** 工具注册表：按名字索引，供参数校验与副作用判定。 */
export class ToolRegistry {
  readonly #tools = new Map<string, ParsedTool>();
  readonly #skipped: SkippedTool[];
  readonly #ajv = new Ajv2020({ strict: false, allErrors: true, coerceTypes: false });

  constructor(tools: ParsedTool[], skipped: SkippedTool[] = []) {
    for (const tool of tools) {
      this.#tools.set(tool.name, tool);
    }
    this.#skipped = skipped;
  }

  static fromRequest(rawTools: unknown[] | undefined): ToolRegistry {
    if (rawTools === undefined) return new ToolRegistry([]);
    const skipped: SkippedTool[] = [];
    const parsed = rawTools.flatMap((raw, index) => parseTool(raw, index, skipped));
    // 名字重复直接报错，避免歧义
    const seen = new Set<string>();
    for (const tool of parsed) {
      if (seen.has(tool.name)) {
        throw ApiError.badRequest(`工具名重复：${tool.name}`, 'tools');
      }
      seen.add(tool.name);
    }
    return new ToolRegistry(parsed, skipped);
  }

  /** 客户端声明了但本网关执行不了、已被跳过的工具。调用方应据此告知用户。 */
  get skipped(): readonly SkippedTool[] {
    return this.#skipped;
  }

  get size(): number {
    return this.#tools.size;
  }

  list(): ParsedTool[] {
    return [...this.#tools.values()];
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  get(name: string): ParsedTool | undefined {
    return this.#tools.get(name);
  }

  isSideEffect(name: string): boolean {
    // 未声明的工具也按副作用处理（保守）
    return this.#tools.get(name)?.sideEffect ?? true;
  }

  /** 转成给上游的工具声明。 */
  toDeclarations(): ToolDeclaration[] {
    return [...this.#tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description ?? undefined,
      parameters: tool.parameters ?? undefined,
    }));
  }

  /**
   * 校验模型产出的工具调用参数。
   * 未声明的工具、非法 JSON、或不符合 schema 都返回 valid=false 与错误摘要。
   */
  validateArguments(name: string, argumentsJson: string): ArgumentValidation {
    const tool = this.#tools.get(name);
    if (tool === undefined) {
      // 工具名精确匹配：大小写、空格差异都算未声明
      return { valid: false, reason: 'undeclared', errors: [`调用了未声明的工具 ${name}`] };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(argumentsJson === '' ? '{}' : argumentsJson);
    } catch {
      return { valid: false, reason: 'invalid_json', errors: ['工具参数不是合法 JSON'] };
    }

    // 无参数 schema 的工具只要求参数是 JSON 对象
    if (tool.parameters === null) {
      return typeof parsed === 'object' && parsed !== null
        ? { valid: true, errors: [] }
        : { valid: false, reason: 'schema', errors: ['工具参数应为 JSON 对象'] };
    }

    let validate;
    try {
      validate = this.#ajv.compile(tool.parameters);
    } catch (error) {
      // schema 本身无法编译：不拦截调用，但记录
      return {
        valid: false,
        reason: 'schema',
        errors: [`工具 ${name} 的参数 schema 非法：${(error as Error).message}`],
      };
    }

    if (validate(parsed)) {
      return { valid: true, errors: [] };
    }
    const errors = (validate.errors ?? []).map((err) => {
      const path = err.instancePath === '' ? '(根)' : err.instancePath;
      return `${path} ${err.message ?? '不合法'}`;
    });
    return {
      valid: false,
      reason: 'schema',
      errors: errors.length > 0 ? errors : ['参数不符合工具 schema'],
    };
  }
}
