import { useState } from 'react';
import { api, type CodexConfigResponse } from '../api';
import { CopyButton } from '../components/CopyButton';
import { ErrorBanner } from '../components/ErrorBanner';
import { Layout } from '../components/Layout';

const DEFAULT_ENV_KEY = 'M365_CODEX_API_KEY';

export function CodexConfigPage() {
  const [apiKeyEnv, setApiKeyEnv] = useState(DEFAULT_ENV_KEY);
  const [config, setConfig] = useState<CodexConfigResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const generate = () => {
    setLoading(true);
    setError(null);
    api
      .getCodexConfig(apiKeyEnv.trim() || DEFAULT_ENV_KEY)
      .then((res) => setConfig(res))
      .catch((err: unknown) => setError(err))
      .finally(() => setLoading(false));
  };

  return (
    <Layout title="Codex 配置" subtitle="生成可直接粘贴到 ~/.codex/config.toml 的片段">
      <div className="card">
        <div className="field">
          <label htmlFor="codex-env-key">存放 API Key 的环境变量名</label>
          <input
            id="codex-env-key"
            type="text"
            value={apiKeyEnv}
            onChange={(e) => setApiKeyEnv(e.target.value)}
          />
          <span className="field-hint">
            生成的配置只引用这个环境变量名，不会把 API Key 明文写进 TOML 里；
            请把创建好的 <code>sk-</code> 密钥设置到这个环境变量。
          </span>
        </div>
        {error !== null && (
          <div style={{ marginBottom: 12 }}>
            <ErrorBanner error={error} />
          </div>
        )}
        <button type="button" className="btn btn-primary" onClick={generate} disabled={loading}>
          {loading ? '生成中…' : '生成配置'}
        </button>
      </div>

      {config !== null && (
        <div className="card">
          <div className="flex-between" style={{ marginBottom: 10 }}>
            <h2 style={{ margin: 0 }}>config.toml 片段</h2>
            <CopyButton value={config.toml} label="复制片段" />
          </div>
          <pre className="mono" style={{ background: 'var(--bg-inset)', padding: 14, borderRadius: 'var(--radius-md)', overflowX: 'auto' }}>
            {config.toml}
          </pre>

          <div className="error-banner" style={{ marginTop: 4 }}>
            <div className="error-title">关于 wire_api</div>
            <div>
              Codex 自 2026 年 2 月起 <code>wire_api</code> 只支持 <code>&quot;responses&quot;</code>
              （<code>&quot;chat&quot;</code> 已移除，省略时也默认 responses）。这里固定生成
              <code>wire_api = &quot;responses&quot;</code>，同时意味着 <code>/v1/chat/completions</code>{' '}
              端点不再供 Codex 自身使用，它保留给其他仍走 Chat Completions 的 OpenAI 兼容客户端。
            </div>
          </div>

          {config.notes.length > 0 && (
            <ul style={{ marginTop: 14 }}>
              {config.notes.map((note) => (
                <li key={note} className="text-muted">
                  {note}
                </li>
              ))}
            </ul>
          )}

          <div className="text-muted" style={{ marginTop: 10 }}>
            对外 API Base URL：<span className="mono">{config.base_url}</span>
          </div>
        </div>
      )}
    </Layout>
  );
}
