import { useEffect, useState } from 'react';
import { IconMoon, IconSun } from './icons';

type Preference = 'system' | 'light' | 'dark';
const STORAGE_KEY = 'm365codex.theme';

function apply(pref: Preference): void {
  const root = document.documentElement;
  if (pref === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', pref);
  }
}

function initial(): Preference {
  const stored = sessionStorage.getItem(STORAGE_KEY);
  return stored === 'light' || stored === 'dark' ? stored : 'system';
}

/** 纯展示偏好，不是凭据，存 sessionStorage 即可；默认跟随系统。 */
export function ThemeToggle() {
  const [pref, setPref] = useState<Preference>(initial);

  useEffect(() => {
    apply(pref);
    sessionStorage.setItem(STORAGE_KEY, pref);
  }, [pref]);

  const next = (): Preference => (pref === 'system' ? 'light' : pref === 'light' ? 'dark' : 'system');

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={() => setPref(next())}
      title="切换深浅色（跟随系统 / 浅色 / 深色）"
    >
      {pref === 'dark' ? <IconMoon /> : <IconSun />}
      {' '}
      {pref === 'system' ? '跟随系统' : pref === 'light' ? '浅色' : '深色'}
    </button>
  );
}
