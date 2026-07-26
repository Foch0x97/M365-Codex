import { useState } from 'react';
import { CopyButton } from './CopyButton';

/**
 * API Key 创建后明文只会出现这一次——服务端不保存明文，之后任何接口都拿不到它。
 * 关闭前必须勾选「我已保存」，避免用户手滑关掉弹窗后再也找不回这个密钥。
 */
export function RevealApiKeyModal({ apiKey, onClose }: { apiKey: string; onClose: () => void }) {
  const [confirmed, setConfirmed] = useState(false);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="reveal-key-title">
      <div className="modal">
        <h2 id="reveal-key-title" style={{ marginTop: 0 }}>
          密钥已创建
        </h2>
        <div className="error-banner" style={{ marginBottom: 16 }}>
          <div className="error-title">这是唯一一次显示完整密钥的机会</div>
          <div>关闭本弹窗后，服务端不会再保存明文，也无法再次查看——请立即复制并妥善保存。</div>
        </div>
        <div className="mono-copy" style={{ width: '100%', justifyContent: 'space-between' }}>
          <span style={{ overflowWrap: 'anywhere' }}>{apiKey}</span>
        </div>
        <div style={{ marginTop: 10 }}>
          <CopyButton value={apiKey} label="复制密钥" />
        </div>
        <label className="checkbox-row" style={{ marginTop: 20 }}>
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          我已保存这个密钥
        </label>
        <div style={{ marginTop: 16 }}>
          <button type="button" className="btn btn-primary" disabled={!confirmed} onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
