import { describe, expect, it } from 'vitest';
import { ApiError } from '@m365-codex/shared';
import { parseTool, ToolRegistry } from '../src/tools/registry.js';

const weatherTool = {
  type: 'function',
  name: 'get_weather',
  description: '查询天气',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' }, days: { type: 'integer' } },
    required: ['city'],
    additionalProperties: false,
  },
};

describe('parseTool', () => {
  it('解析扁平 function 定义', () => {
    const tool = parseTool(weatherTool, 0);
    expect(tool.name).toBe('get_weather');
    expect(tool.description).toBe('查询天气');
    expect(tool.sideEffect).toBe(true);
  });

  it('解析嵌套 function 定义', () => {
    const tool = parseTool({ type: 'function', function: { name: 'foo', parameters: {} } }, 0);
    expect(tool.name).toBe('foo');
  });

  it('x_side_effect: false 标为只读', () => {
    const tool = parseTool({ ...weatherTool, x_side_effect: false }, 0);
    expect(tool.sideEffect).toBe(false);
  });

  it('缺少 name 报错', () => {
    expect(() => parseTool({ type: 'function' }, 0)).toThrow(ApiError);
  });

  it('非 function 类型（托管内置工具）返回 unsupported_feature', () => {
    try {
      parseTool({ type: 'web_search' }, 0);
      throw new Error('本应抛出');
    } catch (error) {
      expect((error as ApiError).type).toBe('unsupported_feature');
    }
  });
});

describe('ToolRegistry.fromRequest', () => {
  it('空/未定义工具返回空注册表', () => {
    expect(ToolRegistry.fromRequest(undefined).size).toBe(0);
    expect(ToolRegistry.fromRequest([]).size).toBe(0);
  });

  it('工具名重复报错', () => {
    expect(() => ToolRegistry.fromRequest([weatherTool, weatherTool])).toThrow(/重复/);
  });

  it('toDeclarations 转成上游声明', () => {
    const decls = ToolRegistry.fromRequest([weatherTool]).toDeclarations();
    expect(decls[0]?.name).toBe('get_weather');
    expect(decls[0]?.parameters).toBeDefined();
  });
});

describe('validateArguments', () => {
  const registry = ToolRegistry.fromRequest([weatherTool]);

  it('合法参数通过', () => {
    expect(registry.validateArguments('get_weather', '{"city":"北京"}').valid).toBe(true);
  });

  it('缺少必填字段不通过', () => {
    const result = registry.validateArguments('get_weather', '{"days":3}');
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('类型错误不通过', () => {
    expect(registry.validateArguments('get_weather', '{"city":"北京","days":"三"}').valid).toBe(false);
  });

  it('多余字段不通过（additionalProperties:false）', () => {
    expect(registry.validateArguments('get_weather', '{"city":"北京","x":1}').valid).toBe(false);
  });

  it('非法 JSON 不通过', () => {
    const result = registry.validateArguments('get_weather', '{不是json');
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('JSON');
  });

  it('未声明的工具不通过', () => {
    const result = registry.validateArguments('unknown_tool', '{}');
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('未声明');
  });

  it('无参数 schema 的工具只要求是对象', () => {
    const reg = ToolRegistry.fromRequest([{ type: 'function', name: 'noop' }]);
    expect(reg.validateArguments('noop', '{}').valid).toBe(true);
    expect(reg.validateArguments('noop', '"字符串"').valid).toBe(false);
  });
});

describe('isSideEffect', () => {
  it('默认工具按副作用处理', () => {
    const reg = ToolRegistry.fromRequest([weatherTool]);
    expect(reg.isSideEffect('get_weather')).toBe(true);
  });

  it('未声明的工具也按副作用处理（保守）', () => {
    const reg = ToolRegistry.fromRequest([]);
    expect(reg.isSideEffect('anything')).toBe(true);
  });

  it('显式只读工具不算副作用', () => {
    const reg = ToolRegistry.fromRequest([{ ...weatherTool, x_side_effect: false }]);
    expect(reg.isSideEffect('get_weather')).toBe(false);
  });
});
