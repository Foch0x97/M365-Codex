import { jsx as _jsx } from "react/jsx-runtime";
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App';
import { AuthProvider } from './auth/AuthContext';
import './styles/global.css';
const container = document.getElementById('root');
if (container === null)
    throw new Error('未找到 #root 挂载点');
createRoot(container).render(_jsx(StrictMode, { children: _jsx(BrowserRouter, { basename: import.meta.env.BASE_URL, children: _jsx(AuthProvider, { children: _jsx(App, {}) }) }) }));
