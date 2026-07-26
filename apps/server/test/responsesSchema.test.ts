import { describe, expect, it } from 'vitest';
import { ApiError } from '@m365-codex/shared';
import {
  buildPassthrough,
  extractInputText,
  extractReasoningEffort,
  parseResponsesRequest,
} from '../src/responses/schema.js';

describe('parseResponsesRequest', () => {
  it('接受最小请求', () => {
    const req = parseResponsesRequest({ model: 'gpt-5-codex', input: '你好' });
    expect(req.model).toBe('gpt-5-codex');
    expect(req.stream).toBe(false);
  });

  it('缺少 model 报错', () => {
    expect(() => parseResponsesRequest({ input: 'x' })).toThrow(ApiError);
  });

  it('缺少 input 报错', () => {
    expect(() => parseResponsesRequest({ model: 'm' })).toThrow(ApiError);
  });

  it('保留未知字段（透传友好）', () => {
    const req = parseResponsesRequest({ model: 'm', input: 'x', custom_field: 1 });
    expect((req as Record<string, unknown>).custom_field).toBe(1);
  });

  it('接受完整字段集', () => {
    const req = parseResponsesRequest({
      model: 'gpt-5-codex',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      instructions: '你是助手',
      stream: true,
      tools: [{ type: 'function', name: 'foo' }],
      previous_response_id: 'resp_prev',
      metadata: { k: 'v' },
      max_output_tokens: 100,
      temperature: 0.5,
      reasoning: { effort: 'high' },
    });
    expect(req.stream).toBe(true);
    expect(req.reasoning?.effort).toBe('high');
  });

  it('temperature 越界报错', () => {
    expect(() => parseResponsesRequest({ model: 'm', input: 'x', temperature: 5 })).toThrow(ApiError);
  });
});

describe('extractInputText', () => {
  it('字符串 input 直接作为文本', () => {
    const req = parseResponsesRequest({ model: 'm', input: '直接文本' });
    expect(extractInputText(req).text).toBe('直接文本');
  });

  it('数组 input 拼接 input_text 部分', () => {
    const req = parseResponsesRequest({
      model: 'm',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: '第一段' }] },
        { role: 'user', content: '第二段' },
      ],
    });
    expect(extractInputText(req).text).toBe('第一段\n\n第二段');
  });

  it('跳过 assistant 的字符串内容', () => {
    const req = parseResponsesRequest({
      model: 'm',
      input: [
        { role: 'assistant', content: '上轮回答' },
        { role: 'user', content: '新问题' },
      ],
    });
    expect(extractInputText(req).text).toBe('新问题');
  });

  it('图片输入返回清晰的 unsupported_feature 错误（M6）', () => {
    const req = parseResponsesRequest({
      model: 'm',
      input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'x' }] }],
    });
    try {
      extractInputText(req);
      throw new Error('本应抛出');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).type).toBe('unsupported_feature');
      expect((error as ApiError).message).toContain('M6');
    }
  });

  it('文件输入返回 unsupported_feature（M6）', () => {
    const req = parseResponsesRequest({
      model: 'm',
      input: [{ role: 'user', content: [{ type: 'input_file', file_id: 'x' }] }],
    });
    expect(() => extractInputText(req)).toThrow(/M6/);
  });

  it('function_call_output 返回 unsupported_feature（M5）', () => {
    const req = parseResponsesRequest({
      model: 'm',
      input: [{ type: 'function_call_output', call_id: 'c1', output: '结果' }],
    });
    expect(() => extractInputText(req)).toThrow(/M5/);
  });

  it('提取 instructions', () => {
    const req = parseResponsesRequest({ model: 'm', input: 'x', instructions: '系统指令' });
    expect(extractInputText(req).instructions).toBe('系统指令');
  });
});

describe('buildPassthrough', () => {
  it('原样带上 model 与 reasoning，不改写', () => {
    const req = parseResponsesRequest({
      model: 'gpt-5-codex',
      input: 'x',
      reasoning: { effort: 'xhigh' },
      temperature: 0.7,
      max_output_tokens: 200,
    });
    const p = buildPassthrough(req);
    expect(p.model).toBe('gpt-5-codex');
    expect(p.reasoning).toEqual({ effort: 'xhigh' });
    expect(p.temperature).toBe(0.7);
    expect(p.max_output_tokens).toBe(200);
  });

  it('不注入未提供的字段', () => {
    const req = parseResponsesRequest({ model: 'm', input: 'x' });
    const p = buildPassthrough(req);
    expect(p).toEqual({ model: 'm' });
  });
});

describe('extractReasoningEffort', () => {
  it('取出 effort 原值，不枚举校验', () => {
    const req = parseResponsesRequest({ model: 'm', input: 'x', reasoning: { effort: '随便什么值' } });
    expect(extractReasoningEffort(req)).toBe('随便什么值');
  });

  it('无 reasoning 时返回 null', () => {
    const req = parseResponsesRequest({ model: 'm', input: 'x' });
    expect(extractReasoningEffort(req)).toBeNull();
  });
});
