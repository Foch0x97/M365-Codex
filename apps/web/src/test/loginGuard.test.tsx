import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router';
import { App } from '../App';
import { AuthProvider } from '../auth/AuthContext';

/**
 * 登录守卫：没有会话（sessionStorage 为空，afterEach 也会清空）时，
 * 访问任何受保护路径都必须落回登录页，而不是把受保护页面短暂渲染出来。
 */
describe('登录守卫', () => {
  it('未登录访问概览页会被重定向到登录页', async () => {
    render(
      <MemoryRouter initialEntries={['/overview']}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText('管理员登录')).toBeTruthy();
    expect(screen.queryByText('概览')).toBeNull();
  });

  it('未登录访问 API Key 页也会被重定向到登录页', async () => {
    render(
      <MemoryRouter initialEntries={['/api-keys']}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText('管理员登录')).toBeTruthy();
  });
});
