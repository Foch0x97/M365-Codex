import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '../api';
import { ErrorBanner } from '../components/ErrorBanner';

describe('ErrorBanner 统一错误体展示', () => {
  it('展示错误信息与 request_id，方便用户报障时提供排查线索', () => {
    const error = new ApiRequestError(400, {
      error: {
        type: 'invalid_request_error',
        message: 'expires_at 必须晚于 starts_at',
        param: 'expires_at',
        request_id: 'req_abc123',
      },
    });

    render(<ErrorBanner error={error} />);

    expect(screen.getByText('请求不合法')).toBeTruthy();
    expect(screen.getByText('expires_at 必须晚于 starts_at')).toBeTruthy();
    expect(screen.getByText(/req_abc123/)).toBeTruthy();
    expect(screen.getAllByText(/expires_at/).length).toBeGreaterThan(0);
  });

  it('error 为空时不渲染任何内容', () => {
    const { container } = render(<ErrorBanner error={null} />);
    expect(container.textContent).toBe('');
  });

  it('非 ApiRequestError 的普通异常也能友好展示', () => {
    render(<ErrorBanner error={new Error('网络已断开')} />);
    expect(screen.getByText('发生错误')).toBeTruthy();
    expect(screen.getByText('网络已断开')).toBeTruthy();
  });
});
