import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '../api';
import { setAuthToken, setUnauthorizedHandler } from '../api/http';

/**
 * 会话令牌只放两个地方：这里的 React state（内存）与 sessionStorage（用于刷新页面后恢复登录态）。
 * 绝不写 localStorage，绝不出现在任何日志/console 调用里。
 */

const SESSION_STORAGE_KEY = 'm365codex.admin.session';

interface StoredSession {
  token: string;
  expires_at: number;
}

interface AuthContextValue {
  token: string | null;
  expiresAt: number | null;
  status: 'checking' | 'authenticated' | 'anonymous';
  login: (password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function readStoredSession(): StoredSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as StoredSession;
    if (typeof parsed.token !== 'string' || typeof parsed.expires_at !== 'number') return null;
    if (parsed.expires_at <= Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeStoredSession(session: StoredSession | null): void {
  if (session === null) {
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
  } else {
    sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [status, setStatus] = useState<'checking' | 'authenticated' | 'anonymous'>('checking');

  const clearSession = useCallback(() => {
    setToken(null);
    setExpiresAt(null);
    setAuthToken(null);
    writeStoredSession(null);
    setStatus('anonymous');
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(clearSession);
    return () => setUnauthorizedHandler(null);
  }, [clearSession]);

  // 首次加载：尝试恢复 sessionStorage 里的会话，并向服务端校验仍然有效。
  useEffect(() => {
    const stored = readStoredSession();
    if (stored === null) {
      setStatus('anonymous');
      return;
    }
    setAuthToken(stored.token);
    api
      .getSession()
      .then(() => {
        setToken(stored.token);
        setExpiresAt(stored.expires_at);
        setStatus('authenticated');
      })
      .catch(() => {
        clearSession();
      });
    // clearSession 由 useCallback([]) 生成，引用恒定，加入依赖不会导致这个「仅挂载时执行一次」的
    // 效果重复触发；但它确实在效果体内被使用，因此如实列出。
  }, [clearSession]);

  const login = useCallback(async (password: string) => {
    const res = await api.login(password);
    setAuthToken(res.token);
    writeStoredSession({ token: res.token, expires_at: res.expires_at });
    setToken(res.token);
    setExpiresAt(res.expires_at);
    setStatus('authenticated');
  }, []);

  const logout = useCallback(() => {
    api.logout().catch(() => {
      /* 注销失败也要清本地状态，不能把用户卡在已登录界面 */
    });
    clearSession();
  }, [clearSession]);

  const value = useMemo<AuthContextValue>(
    () => ({ token, expiresAt, status, login, logout }),
    [token, expiresAt, status, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (ctx === null) throw new Error('useAuth 必须在 AuthProvider 内使用');
  return ctx;
}
