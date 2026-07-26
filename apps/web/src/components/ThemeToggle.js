import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from 'react';
import { IconMoon, IconSun } from './icons';
const STORAGE_KEY = 'm365codex.theme';
function apply(pref) {
    const root = document.documentElement;
    if (pref === 'system') {
        root.removeAttribute('data-theme');
    }
    else {
        root.setAttribute('data-theme', pref);
    }
}
function initial() {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
}
/** 纯展示偏好，不是凭据，存 sessionStorage 即可；默认跟随系统。 */
export function ThemeToggle() {
    const [pref, setPref] = useState(initial);
    useEffect(() => {
        apply(pref);
        sessionStorage.setItem(STORAGE_KEY, pref);
    }, [pref]);
    const next = () => (pref === 'system' ? 'light' : pref === 'light' ? 'dark' : 'system');
    return (_jsxs("button", { type: "button", className: "theme-toggle", onClick: () => setPref(next()), title: "\u5207\u6362\u6DF1\u6D45\u8272\uFF08\u8DDF\u968F\u7CFB\u7EDF / \u6D45\u8272 / \u6DF1\u8272\uFF09", children: [pref === 'dark' ? _jsx(IconMoon, {}) : _jsx(IconSun, {}), ' ', pref === 'system' ? '跟随系统' : pref === 'light' ? '浅色' : '深色'] }));
}
