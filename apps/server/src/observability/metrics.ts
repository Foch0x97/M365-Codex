/**
 * 运行指标（对应实施计划 §17）。
 *
 * 自己实现一个极小的 Prometheus 文本格式注册表，不引 prom-client：需要的只有
 * 计数器与直方图两种，且指标集是固定的，一个依赖换四十行不划算。
 *
 * **隐私红线**：指标里绝不出现邮箱、提示词、输出正文、Token、文件名。
 * 标签取值必须是有限的枚举（模型名、错误分类、账号 ID 这类），否则会把时间序列
 * 打爆，也容易把用户内容带出去。因此这里对标签值做白名单式的清洗。
 */

export type Labels = Record<string, string>;

/**
 * JWT / Bearer Token 形态：三段 base64url 用点分隔，或以 `eyJ`（`{"` 的 base64）开头。
 * 门槛放得比真实 JWT 宽——误判的代价只是某个标签值变成 redacted，
 * 漏判的代价是把凭据写进了指标，两者不对称。
 */
const TOKEN_SHAPE = /^(eyJ[A-Za-z0-9_-]{4,}|[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{2,})/;
/** `sk-` 开头的对外 API Key 形态。 */
const API_KEY_SHAPE = /^sk-[A-Za-z0-9]{8,}$/;

/**
 * 清洗标签值。
 *
 * 两层防护：
 * 1. 字符白名单——把中文提示词、邮箱的 `@` 这类内容变成下划线，顺带限制长度，
 *    避免高基数标签把时间序列打爆；
 * 2. 形态识别——JWT 与 `sk-` Key 全由白名单字符组成，charset 拦不住，
 *    所以按形态整体替换。调用方本来就不该把凭据当标签，这里是兜底。
 */
function sanitizeLabelValue(value: string): string {
  if (TOKEN_SHAPE.test(value) || API_KEY_SHAPE.test(value)) return 'redacted';
  return value.replace(/[^A-Za-z0-9_:.\-/]/g, '_').slice(0, 64);
}

function labelsKey(labels: Labels): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  return entries.map(([k, v]) => `${k}="${sanitizeLabelValue(v)}"`).join(',');
}

interface Series {
  labels: string;
  value: number;
}

class Counter {
  readonly #series = new Map<string, Series>();

  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  inc(labels: Labels = {}, delta = 1): void {
    const key = labelsKey(labels);
    const existing = this.#series.get(key);
    if (existing === undefined) {
      this.#series.set(key, { labels: key, value: delta });
      return;
    }
    existing.value += delta;
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    if (this.#series.size === 0) {
      lines.push(`${this.name} 0`);
      return lines;
    }
    for (const series of this.#series.values()) {
      const suffix = series.labels === '' ? '' : `{${series.labels}}`;
      lines.push(`${this.name}${suffix} ${series.value}`);
    }
    return lines;
  }
}

class Histogram {
  readonly #buckets: number[];
  readonly #series = new Map<string, { labels: string; counts: number[]; sum: number; total: number }>();

  constructor(
    readonly name: string,
    readonly help: string,
    buckets: number[],
  ) {
    this.#buckets = [...buckets].sort((a, b) => a - b);
  }

  observe(value: number, labels: Labels = {}): void {
    const key = labelsKey(labels);
    let series = this.#series.get(key);
    if (series === undefined) {
      series = { labels: key, counts: new Array<number>(this.#buckets.length).fill(0), sum: 0, total: 0 };
      this.#series.set(key, series);
    }
    series.sum += value;
    series.total += 1;
    for (let i = 0; i < this.#buckets.length; i += 1) {
      if (value <= (this.#buckets[i] as number)) series.counts[i] = (series.counts[i] as number) + 1;
    }
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const series of this.#series.values()) {
      const base = series.labels === '' ? '' : `${series.labels},`;
      for (let i = 0; i < this.#buckets.length; i += 1) {
        lines.push(`${this.name}_bucket{${base}le="${this.#buckets[i]}"} ${series.counts[i]}`);
      }
      lines.push(`${this.name}_bucket{${base}le="+Inf"} ${series.total}`);
      const suffix = series.labels === '' ? '' : `{${series.labels}}`;
      lines.push(`${this.name}_sum${suffix} ${series.sum}`);
      lines.push(`${this.name}_count${suffix} ${series.total}`);
    }
    return lines;
  }
}

/**
 * 指标注册表。指标名与含义在此集中定义，调用方只管打点。
 */
export class Metrics {
  readonly requests = new Counter('m365codex_requests_total', '按端点与状态分类的请求数');
  readonly requestDuration = new Histogram(
    'm365codex_request_duration_seconds',
    '请求耗时（秒）',
    [0.1, 0.5, 1, 2, 5, 10, 30, 60],
  );
  readonly upstreamAttempts = new Counter('m365codex_upstream_attempts_total', '上游调用次数（按结果分类）');
  readonly upstreamErrors = new Counter('m365codex_upstream_errors_total', '上游错误数（按错误分类）');
  readonly sseInterrupted = new Counter('m365codex_sse_interrupted_total', 'SSE 中断次数');
  readonly toolCalls = new Counter('m365codex_tool_calls_total', '发出的工具调用数');
  readonly toolRounds = new Histogram('m365codex_tool_rounds', '单条对话链的工具轮次', [1, 2, 3, 5, 8, 13, 21]);
  readonly toolArgValidations = new Counter(
    'm365codex_tool_arg_validations_total',
    '工具参数校验结果（pass / repaired / rejected）',
  );
  readonly tokenRefresh = new Counter('m365codex_token_refresh_total', 'Token 刷新结果');
  readonly accountStates = new Counter('m365codex_account_state_transitions_total', '账号状态迁移');

  /** 由外部在抓取时填充的即时值（账号数、文件占用等）。 */
  #gauges = new Map<string, { help: string; value: number; labels: string }>();

  setGauge(name: string, help: string, value: number, labels: Labels = {}): void {
    this.#gauges.set(`${name}|${labelsKey(labels)}`, { help, value, labels: labelsKey(labels) });
  }

  /** 渲染成 Prometheus 文本格式。 */
  render(): string {
    const lines: string[] = [];
    for (const metric of [
      this.requests,
      this.upstreamAttempts,
      this.upstreamErrors,
      this.sseInterrupted,
      this.toolCalls,
      this.toolArgValidations,
      this.tokenRefresh,
      this.accountStates,
    ]) {
      lines.push(...metric.render());
    }
    lines.push(...this.requestDuration.render());
    lines.push(...this.toolRounds.render());

    const seen = new Set<string>();
    for (const [key, gauge] of this.#gauges) {
      const name = key.split('|')[0] as string;
      if (!seen.has(name)) {
        lines.push(`# HELP ${name} ${gauge.help}`, `# TYPE ${name} gauge`);
        seen.add(name);
      }
      const suffix = gauge.labels === '' ? '' : `{${gauge.labels}}`;
      lines.push(`${name}${suffix} ${gauge.value}`);
    }
    return `${lines.join('\n')}\n`;
  }
}

export const CONTENT_TYPE_PROMETHEUS = 'text/plain; version=0.0.4; charset=utf-8';
