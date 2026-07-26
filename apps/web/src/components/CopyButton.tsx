import { useState } from 'react';
import { IconCheck, IconCopy } from './icons';

/** 复制到剪贴板；复制成功后短暂显示对勾反馈。剪贴板 API 不可用时静默失败，不抛错打断页面。 */
export function CopyButton({ value, label = '复制' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard
      .writeText(value)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        /* 剪贴板权限被拒绝等场景：不打断用户，静默即可 */
      });
  };

  return (
    <button type="button" className="btn btn-sm" onClick={handleCopy}>
      {copied ? <IconCheck /> : <IconCopy />}
      {copied ? '已复制' : label}
    </button>
  );
}
