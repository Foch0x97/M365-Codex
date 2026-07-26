import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { AuthProvider } from '../auth/AuthContext';
import { ProxiesPage } from '../pages/ProxiesPage';
import { FilesPage } from '../pages/FilesPage';
import type { BulkImportProxyResult, FileListItem, FilesCleanupResult } from '../api';

/**
 * 服务端 `apps/server/src/routes/adminOps.ts` 的两处真实返回字段：
 *   - POST /admin/proxies/bulk  -> { created, failed, results: [{ line, ok, id?, error? }] }
 *   - POST /admin/files/cleanup -> { deleted_files, deleted_uploads, freed_bytes }
 * 之前前端类型/页面用的是 { succeeded, errors } 与 { deleted }，真实联调时会渲染成 undefined。
 * 这里直接用服务端真实形状的数据驱动页面，断言 UI 读到的是正确字段而不是 undefined。
 */

const listProxies = vi.fn<() => Promise<[]>>();
const bulkImportProxies = vi.fn<(payload: unknown) => Promise<BulkImportProxyResult>>();
const listFiles = vi.fn<() => Promise<{ items: FileListItem[]; total_bytes: number }>>();
const cleanupFiles = vi.fn<() => Promise<FilesCleanupResult>>();

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return {
    ...actual,
    api: {
      ...actual.api,
      listProxies: (...args: []) => listProxies(...args),
      bulkImportProxies: (...args: [unknown]) => bulkImportProxies(...args),
      listFiles: (...args: []) => listFiles(...args),
      cleanupFiles: (...args: []) => cleanupFiles(...args),
    },
  };
});

describe('代理批量导入结果字段对齐服务端', () => {
  beforeEach(() => {
    listProxies.mockReset().mockResolvedValue([]);
    bulkImportProxies.mockReset();
  });

  it('用服务端真实形状 {created, failed, results} 渲染，不出现 undefined', async () => {
    bulkImportProxies.mockResolvedValue({
      created: 1,
      failed: 1,
      results: [
        { line: 'http://1.2.3.4:8080', ok: true, id: 'proxy_9' },
        { line: 'not-a-url', ok: false, error: 'url 不是合法的 URL' },
      ],
    });

    render(
      <MemoryRouter initialEntries={['/proxies']}>
        <AuthProvider>
          <ProxiesPage />
        </AuthProvider>
      </MemoryRouter>,
    );

    const textarea = await screen.findByLabelText('每行一个地址');
    fireEvent.change(textarea, { target: { value: 'http://1.2.3.4:8080\nnot-a-url' } });
    fireEvent.click(screen.getByRole('button', { name: '批量导入' }));

    await screen.findByText('成功 1 条，失败 1 条');
    expect(screen.getByText(/url 不是合法的 URL/)).toBeTruthy();
    expect(document.body.textContent?.includes('undefined')).toBe(false);
  });
});

describe('文件清理结果字段对齐服务端', () => {
  beforeEach(() => {
    listFiles.mockReset().mockResolvedValue({ items: [], total_bytes: 0 });
    cleanupFiles.mockReset();
  });

  it('用服务端真实形状 {deleted_files, deleted_uploads, freed_bytes} 渲染，不出现 undefined', async () => {
    cleanupFiles.mockResolvedValue({ deleted_files: 3, deleted_uploads: 2, freed_bytes: 5_242_880 });

    render(
      <MemoryRouter initialEntries={['/files']}>
        <AuthProvider>
          <FilesPage />
        </AuthProvider>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: '立即清理' }));

    await screen.findByText(/删除文件 3 个、未完成上传 2 个/);
    expect(screen.getByText(/5\.00 MB/)).toBeTruthy();
    expect(document.body.textContent?.includes('undefined')).toBe(false);
  });
});
