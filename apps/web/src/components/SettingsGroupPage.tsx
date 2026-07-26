import { useEffect, useState } from 'react';
import { api, type SettingsGroupName, type SettingsResponse } from '../api';
import { formatDateTime, formatMsWithDuration } from '../util/format';
import { ErrorBanner } from './ErrorBanner';
import { Layout } from './Layout';
import { AsyncSection } from './StateBlock';

export interface SettingFieldMeta {
  key: string;
  label: string;
  kind: 'boolean' | 'number' | 'string' | 'select' | 'datetime' | 'string_list';
  options?: { value: string; label: string }[];
  hint?: string;
  /** 数字字段的展示单位：'ms' 时在输入框旁附带「N 毫秒（X 天/小时/分钟）」的人话展示，提交值仍是毫秒数。 */
  unit?: 'ms';
  min?: number;
  max?: number;
}

const SOURCE_LABEL: Record<string, string> = {
  env: '环境变量',
  db: '数据库',
  default: '默认值',
};

/**
 * 设置分组的通用渲染器：一个分组一个卡片，字段元数据由调用方传入（服务端只返回
 * {value, source, editable, requires_restart}，不返回展示用的标签，所以标签维护在前端）。
 *
 * 规则完全照 docs/管理端API契约.md §2.3：`source="env"` 的项 `editable=false`，
 * UI 上禁用输入并给出「由环境变量固定」的提示，不允许悄悄覆盖容器编排的真源。
 */
export function SettingsGroupPage({
  title,
  subtitle,
  groups,
}: {
  title: string;
  subtitle: string;
  groups: Array<{ group: SettingsGroupName; heading: string; fields: SettingFieldMeta[] }>;
}) {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    api
      .getSettings()
      .then((res) => setData(res))
      .catch((err: unknown) => setError(err))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  return (
    <Layout title={title} subtitle={subtitle}>
      <AsyncSection loading={loading} error={error} data={data} onRetry={load}>
        {(settings) => (
          <>
            {groups.map((g) => (
              <SettingsGroupCard
                key={g.group}
                heading={g.heading}
                group={g.group}
                fields={g.fields}
                values={settings[g.group] as unknown as Record<
                  string,
                  { value: unknown; source: string; editable: boolean; requires_restart: boolean }
                >}
                onSaved={load}
              />
            ))}
          </>
        )}
      </AsyncSection>
    </Layout>
  );
}

function SettingsGroupCard({
  heading,
  group,
  fields,
  values,
  onSaved,
}: {
  heading: string;
  group: SettingsGroupName;
  fields: SettingFieldMeta[];
  values: Record<string, { value: unknown; source: string; editable: boolean; requires_restart: boolean }>;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(fields.map((f) => [f.key, values[f.key]?.value])),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [restartNeeded, setRestartNeeded] = useState(false);

  const handleSubmit = () => {
    setSaving(true);
    setError(null);
    const changed: Record<string, unknown> = {};
    let needsRestart = false;
    for (const f of fields) {
      if (values[f.key]?.editable === true) {
        changed[f.key] = draft[f.key];
        if (values[f.key]?.requires_restart === true) needsRestart = true;
      }
    }
    api
      .updateSettings(group, changed)
      .then(() => {
        setSavedAt(Date.now());
        setRestartNeeded(needsRestart);
        onSaved();
      })
      .catch((err: unknown) => setError(err))
      .finally(() => setSaving(false));
  };

  return (
    <div className="card">
      <div className="flex-between" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>{heading}</h2>
        {savedAt !== null && <span className="text-faint">已保存于 {formatDateTime(savedAt)}</span>}
      </div>
      {savedAt !== null && restartNeeded && (
        <div className="field-hint" style={{ marginBottom: 12 }}>
          <span className="badge badge-warn">重启后生效</span> 本次改动含需要重启的配置项，重启进程前仍按旧值运行。
        </div>
      )}
      {fields.map((f) => {
        const meta = values[f.key];
        const editable = meta?.editable ?? false;
        return (
          <div className="field" key={f.key}>
            <label htmlFor={`setting-${group}-${f.key}`}>
              {f.label}{' '}
              <span className="badge badge-neutral" style={{ marginLeft: 6 }}>
                {SOURCE_LABEL[meta?.source ?? 'default'] ?? meta?.source}
              </span>
              {meta?.requires_restart === true && (
                <span className="badge badge-warn" style={{ marginLeft: 6 }}>
                  需重启生效
                </span>
              )}
            </label>
            <SettingInput
              id={`setting-${group}-${f.key}`}
              meta={f}
              value={draft[f.key]}
              disabled={!editable}
              onChange={(v) => setDraft((d) => ({ ...d, [f.key]: v }))}
            />
            {f.unit === 'ms' && <span className="field-hint">{formatMsWithDuration(draft[f.key])}</span>}
            {!editable && (
              <span className="field-hint">
                {meta?.source === 'env'
                  ? '由环境变量固定，改这里不会生效。'
                  : '当前不可在界面修改。'}
              </span>
            )}
            {f.hint !== undefined && <span className="field-hint">{f.hint}</span>}
          </div>
        );
      })}
      {error !== null && (
        <div style={{ marginBottom: 12 }}>
          <ErrorBanner error={error} />
        </div>
      )}
      <button type="button" className="btn btn-primary" onClick={handleSubmit} disabled={saving}>
        {saving ? '保存中…' : '保存'}
      </button>
    </div>
  );
}

function SettingInput({
  id,
  meta,
  value,
  disabled,
  onChange,
}: {
  id: string;
  meta: SettingFieldMeta;
  value: unknown;
  disabled: boolean;
  onChange: (value: unknown) => void;
}) {
  if (meta.kind === 'boolean') {
    return (
      <label className="checkbox-row">
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        {value === true ? '已启用' : '已关闭'}
      </label>
    );
  }
  if (meta.kind === 'select') {
    return (
      <select
        id={id}
        value={String(value ?? '')}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {meta.options?.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    );
  }
  if (meta.kind === 'number') {
    return (
      <input
        id={id}
        type="number"
        min={meta.min}
        max={meta.max}
        value={value === null || value === undefined ? '' : String(value)}
        disabled={disabled}
        onChange={(e) => {
          if (e.target.value === '') {
            onChange(null);
            return;
          }
          let next = Number(e.target.value);
          if (meta.min !== undefined && next < meta.min) next = meta.min;
          if (meta.max !== undefined && next > meta.max) next = meta.max;
          onChange(next);
        }}
      />
    );
  }
  if (meta.kind === 'string_list') {
    // 服务端类型是字符串数组，界面按空格分隔的单行文本编辑，提交前再切回数组。
    const text = Array.isArray(value) ? value.join(' ') : '';
    return (
      <input
        id={id}
        type="text"
        value={text}
        disabled={disabled}
        onChange={(e) =>
          onChange(
            e.target.value
              .split(/\s+/)
              .map((s) => s.trim())
              .filter((s) => s.length > 0),
          )
        }
      />
    );
  }
  return (
    <input
      id={id}
      type="text"
      value={value === null || value === undefined ? '' : String(value)}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
